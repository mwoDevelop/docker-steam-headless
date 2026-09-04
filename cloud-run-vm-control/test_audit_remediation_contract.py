from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "cloud-run-vm-control" / "app.py").read_text(encoding="utf-8")
DEPLOY = (ROOT / "cloud-run-vm-control" / "deploy.sh").read_text(encoding="utf-8")
ADMIN_JS = (ROOT / "docs" / "vm-control" / "admin.js").read_text(encoding="utf-8")


def test_healthcheck_identifies_the_exact_build_on_both_routes():
    assert '@app.route("/healthz"' in APP
    assert '@app.route("/api/healthz"' in APP
    assert 'CONFIG["build_commit_sha"]' in APP
    assert 'CONFIG["cloud_run_revision"]' in APP


def test_deploy_promotes_only_the_health_checked_revision():
    assert "--no-traffic" in DEPLOY
    assert '--tag "$CANDIDATE_TAG"' in DEPLOY
    assert '"${CANDIDATE_URL}/api/healthz"' in DEPLOY
    assert '--to-revisions "${CANDIDATE_REVISION}=100"' in DEPLOY
    assert "--to-latest" not in DEPLOY


def test_all_vm_lifecycle_commands_are_backend_coordinated():
    coordinated = APP.split("LIFECYCLE_COORDINATED_COMMANDS", 1)[1].split("}", 1)[0]
    for command in ("create", "start", "stop", "restart", "delete"):
        assert f'"{command}"' in coordinated
    assert 'if command in LIFECYCLE_COORDINATED_COMMANDS:' in APP
    assert 'run_lifecycle_coordinated(' in APP
    assert '"migration",' in APP
    assert '"endpoint-admin",' in APP


def test_status_reads_do_not_release_or_rebind_endpoint_ips():
    status_branch = APP.split('if command == "status":', 1)[1].split('if command == "create":', 1)[0]
    assert "release_selected_endpoint_ephemeral_ip" not in status_branch
    assert "persist_endpoint" not in status_branch
    reconcile = APP.split("def reconcile_endpoint_instance_bindings", 1)[1].split("\ndef ", 1)[0]
    assert "persist_endpoint" not in reconcile


def test_non_terminated_instances_participate_in_single_vm_admission():
    helper = APP.split("def running_managed_instances_except_selected", 1)[1].split("\ndef ", 1)[0]
    assert '!= "TERMINATED"' in helper
    assert '== "RUNNING"' not in helper


def test_ephemeral_endpoint_cleanup_uses_duckdns_clear_and_generation_fencing():
    assert 'params["clear"] = "true"' in APP
    assert 'current.get("generation"' in APP
    assert 'sync_endpoint_duckdns(endpoint, "")' in APP
    assert '"desiredState": "offline"' in APP or 'endpoint["desiredState"] = "offline"' in APP


def test_admin_endpoint_ui_hides_stale_ephemeral_ips_for_offline_vms():
    assert 'instanceState === "RUNNING" && externalIp' in ADMIN_JS
    assert '"Offline - no external IP"' in ADMIN_JS


def test_all_gui_entrypoints_declare_the_repository_favicon():
    assert (ROOT / "docs" / "vm-control" / "favicon.svg").is_file()
    for name in ("index.html", "admin.html", "minecraft-admin.html", "vm-admin.html"):
        html = (ROOT / "docs" / "vm-control" / name).read_text(encoding="utf-8")
        assert '<link rel="icon" href="./favicon.svg" type="image/svg+xml">' in html
