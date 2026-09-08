import base64
import json
import os
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock

sys.path.insert(0, os.path.dirname(__file__))
import app as api


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def raw_tag(name, number=1, architecture='amd64'):
    return {'name': name, 'last_updated': '2026-09-01T00:00:00Z',
            'images': [{'architecture': architecture, 'os': 'linux', 'digest': f'sha256:{number:064x}'}]}


def component(name, tags=None):
    definition = api.RUNTIME_IMAGE_COMPONENTS[name]
    names = tags or (['debian'] if name == 'steam-headless' else ['java21'])
    return {**{key: definition[key] for key in ('label', 'repository', 'requiresGpu')},
            'candidates': [{'tag': tag, 'aliases': [tag], 'imageRef': f'{definition["repository"]}@sha256:{index:064x}',
                            'updatedAt': '2026-09-01T00:00:00Z'} for index, tag in enumerate(names, 1)],
            'complete': True, 'totalTags': len(names), 'supportedTags': len(names), 'excludedTags': 0}


def catalog():
    return api.normalize_runtime_image_catalog({'schemaVersion': 2, 'updatedAt': now(), 'source': 'docker-hub',
        'components': {key: component(key) for key in api.RUNTIME_IMAGE_COMPONENTS}})


def response(tags, next_page=None, count=None, status=200):
    return SimpleNamespace(status_code=status, json=lambda: {'results': tags, 'next': next_page, 'count': count or len(tags)})


class RuntimeImageCatalogTests(unittest.TestCase):
    def setUp(self):
        for context in (patch.dict(api.CONFIG, {'runtime_images_secret_name': ''}),
                        patch.dict(api.RUNTIME_IMAGE_CATALOG_CACHE, {}, clear=True),
                        patch.object(api, 'RUNTIME_IMAGE_CATALOG_LOCK', threading.Lock())):
            context.start()
            self.addCleanup(context.stop)

    def test_supported_tag_contract(self):
        for tag in ('latest', 'debian', 'debian-0.2.0', 'debian-20260908', 'debian-dev-frontend-revamp'):
            self.assertTrue(api.runtime_image_tag_allowed('steam-headless', tag), tag)
        for tag in ('arch', 'arch-latest', 'debian-random-dev', 'debian-master', 'evil/repo:latest'):
            self.assertFalse(api.runtime_image_tag_allowed('steam-headless', tag), tag)
        for tag in ('java17', 'java21', 'java25', 'stable-java21', 'latest', '2026.9.0-java25'):
            self.assertTrue(api.runtime_image_tag_allowed('minecraft', tag), tag)
        for tag in ('java8', 'java11', 'java21-jdk', 'java21-graalvm', '2026.9.0-java8'):
            self.assertFalse(api.runtime_image_tag_allowed('minecraft', tag), tag)

    def test_all_pages_and_more_than_24_results(self):
        tags = [raw_tag(f'2026.8.{index}-java21', index) for index in range(1, 31)]
        with patch.object(api.requests, 'get', side_effect=[response(tags[:20], 'https://untrusted.example/page', 30), response(tags[20:], None, 30)]) as get:
            result = api.fetch_runtime_image_component_catalog('minecraft')
        self.assertEqual(len(result['candidates']), 30)
        self.assertTrue(result['complete'])
        self.assertEqual(get.call_args_list[1].kwargs['params']['page'], 2)
        self.assertTrue(all(call.args[0] == api.DOCKER_HUB_TAGS_URL.format(repository='itzg/minecraft-server') for call in get.call_args_list))
        self.assertFalse(get.call_args.kwargs['allow_redirects'])

    def test_aliases_and_old_schema_keep_string_tag_and_digest(self):
        old = {'components': {'steam-headless': component('steam-headless')}}
        old['components']['steam-headless']['candidates'][0].pop('aliases')
        old['components']['steam-headless']['candidates'].append({**old['components']['steam-headless']['candidates'][0], 'tag': 'latest'})
        normalized = api.normalize_runtime_image_catalog(old)
        candidate = normalized['components']['steam-headless']['candidates'][0]
        self.assertEqual(candidate['aliases'], ['latest', 'debian'])
        self.assertEqual(candidate['tag'], 'latest')
        self.assertEqual(len(normalized['components']['steam-headless']['candidates']), 1)
        api.RUNTIME_IMAGE_CATALOG_CACHE.update(normalized)
        self.assertEqual(api.runtime_image_candidate('steam-headless', candidate['imageRef'])['tag'], 'latest')

    def test_large_repository_uses_exhaustive_supported_filters(self):
        seen = []
        def fetch(url, **kwargs):
            query = kwargs['params']
            seen.append(query)
            if 'name' not in query:
                self.assertEqual(query['page'], 1)
                return response([raw_tag('java8')], 'next', 1972)
            name = query['name']
            return response([raw_tag(name, len(seen))])
        with patch.object(api.requests, 'get', side_effect=fetch):
            result = api.fetch_runtime_image_component_catalog('minecraft')
        self.assertEqual({query.get('name') for query in seen}, {None, 'java17', 'java21', 'java25', 'latest', 'stable'})
        self.assertEqual(result['supportedTags'], 5)
        self.assertEqual(result['excludedTags'], 1967)
        self.assertTrue(result['complete'])

    def test_architecture_filter_and_repository_boundary(self):
        with patch.object(api.requests, 'get', return_value=response([raw_tag('java21'), raw_tag('java17', 2, 'arm64'), raw_tag('java8', 3)])):
            result = api.fetch_runtime_image_component_catalog('minecraft')
        self.assertEqual(result['supportedTags'], 1)
        self.assertEqual(result['excludedTags'], 2)
        value = catalog()
        value['components']['steam-headless']['candidates'][0]['imageRef'] = 'evil/image@sha256:' + 'a' * 64
        normalized = api.normalize_runtime_image_catalog(value)
        self.assertFalse(normalized['components']['steam-headless']['complete'])
        self.assertTrue(all(not item['imageRef'] for item in normalized['components']['steam-headless']['candidates']))

    def test_repeated_page_and_page_limit_are_errors(self):
        page = response([raw_tag('java21')], 'next')
        with patch.object(api.requests, 'get', return_value=page):
            with self.assertRaises(api.ApiError):
                api.fetch_runtime_image_component_catalog('minecraft')
        with patch.object(api, 'RUNTIME_IMAGE_CATALOG_MAX_PAGES', 1), patch.object(api.requests, 'get', return_value=page):
            with self.assertRaises(api.ApiError):
                api.fetch_runtime_image_component_catalog('minecraft')

    def test_deadline_rate_limit_and_malformed_response(self):
        with patch.object(api.requests, 'get') as get:
            with self.assertRaises(api.ApiError):
                api.fetch_runtime_image_component_catalog('minecraft', time.monotonic() - 1)
            get.assert_not_called()
        for reply in (response([], status=429), response([None]), response([raw_tag('java21')], status=302)):
            with self.subTest(reply=reply), patch.object(api.requests, 'get', return_value=reply):
                with self.assertRaises(api.ApiError):
                    api.fetch_runtime_image_component_catalog('minecraft')

    def test_get_does_not_contact_hub_and_marks_old_cache_stale(self):
        current = catalog()
        api.RUNTIME_IMAGE_CATALOG_CACHE.update(current)
        with patch.object(api.requests, 'get') as get:
            self.assertFalse(api.runtime_image_catalog()['stale'])
            api.RUNTIME_IMAGE_CATALOG_CACHE['updatedAt'] = '2026-07-27T00:00:00Z'
            self.assertTrue(api.runtime_image_catalog()['stale'])
            get.assert_not_called()

    def test_unchanged_refresh_does_not_write_secret(self):
        current = catalog()
        api.RUNTIME_IMAGE_CATALOG_CACHE.update(current)
        with patch.object(api, 'fetch_runtime_image_component_catalog', side_effect=lambda key, deadline: current['components'][key]), patch.object(api, 'save_persisted_runtime_image_catalog') as save:
            result = api.refresh_runtime_image_catalog()
        save.assert_not_called()
        self.assertEqual(result['updatedAt'], current['updatedAt'])
        self.assertTrue(result['lastCheckedAt'])
        self.assertFalse(result['stale'])

    def test_refresh_old_schema_writes_once_and_preserves_complete_catalog(self):
        current = catalog()
        api.RUNTIME_IMAGE_CATALOG_CACHE.update({**current, 'schemaVersion': 0})
        with patch.object(api, 'fetch_runtime_image_component_catalog', side_effect=lambda key, deadline: current['components'][key]), patch.object(api, 'save_persisted_runtime_image_catalog') as save:
            result = api.refresh_runtime_image_catalog(force=False)
        save.assert_called_once()
        self.assertEqual(result['schemaVersion'], 2)
        self.assertFalse(result['stale'])

    def test_network_or_secret_failure_preserves_both_components(self):
        for fail_save in (False, True):
            with self.subTest(fail_save=fail_save):
                current = catalog()
                api.RUNTIME_IMAGE_CATALOG_CACHE.update({**current, 'schemaVersion': 0})
                with patch.object(api, 'fetch_runtime_image_component_catalog', side_effect=(lambda key, deadline: current['components'][key]) if fail_save else [component('steam-headless'), api.ApiError('HTTP 429', 502)]), patch.object(api, 'save_persisted_runtime_image_catalog', side_effect=api.ApiError('Secret unavailable', 502)):
                    result = api.refresh_runtime_image_catalog()
                self.assertEqual(result['components'], current['components'])
                self.assertTrue(result['lastError'])
                self.assertTrue(result['stale'])
                self.assertGreater(result['retryAfterSeconds'], 0)

    def test_automatic_backoff_but_manual_retry_allowed(self):
        current = catalog()
        api.RUNTIME_IMAGE_CATALOG_CACHE.update({**current, 'lastError': 'offline', 'lastAttemptAt': now()})
        with patch.object(api, 'fetch_runtime_image_component_catalog', side_effect=lambda key, deadline: current['components'][key]) as fetch:
            api.refresh_runtime_image_catalog(force=False)
            fetch.assert_not_called()
            result = api.refresh_runtime_image_catalog(force=True)
            self.assertEqual(fetch.call_count, 2)
        self.assertEqual(result['lastError'], '')

    def test_concurrent_refresh_reports_busy_without_duplicate_requests(self):
        api.RUNTIME_IMAGE_CATALOG_CACHE.update(catalog())
        api.RUNTIME_IMAGE_CATALOG_LOCK.acquire()
        try:
            with patch.object(api.requests, 'get') as get:
                result = api.refresh_runtime_image_catalog()
            self.assertTrue(result['refreshing'])
            get.assert_not_called()
        finally:
            api.RUNTIME_IMAGE_CATALOG_LOCK.release()

    def test_worker_reloads_newer_persisted_catalog(self):
        current = catalog()
        encoded = base64.b64encode(json.dumps(current).encode()).decode()
        reply = SimpleNamespace(status_code=200, json=lambda: {'payload': {'data': encoded}})
        api.RUNTIME_IMAGE_CATALOG_CACHE.update({**current, 'loaded': True, 'schemaVersion': 0, 'updatedAt': '2026-07-27T00:00:00Z'})
        with patch.dict(api.CONFIG, {'runtime_images_secret_name': 'catalog-test', 'project': 'test-project'}), patch.object(api, 'compute_session', return_value=SimpleNamespace(get=Mock(return_value=reply))):
            api.load_persisted_runtime_image_catalog(force=True)
        self.assertEqual(api.RUNTIME_IMAGE_CATALOG_CACHE['schemaVersion'], 2)
        self.assertEqual(api.RUNTIME_IMAGE_CATALOG_CACHE['updatedAt'], current['updatedAt'])


if __name__ == '__main__':
    unittest.main()
