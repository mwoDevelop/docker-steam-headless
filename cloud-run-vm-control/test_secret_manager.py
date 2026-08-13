from __future__ import annotations

import base64

import app


class Response:
    def __init__(self, status_code: int, payload: bytes = b"") -> None:
        self.status_code = status_code
        self.text = "error"
        self._payload = payload

    def json(self) -> dict[str, object]:
        return {
            "payload": {
                "data": base64.b64encode(self._payload).decode("ascii"),
            }
        }


class Session:
    def __init__(self, current: bytes) -> None:
        self.current = current
        self.posts: list[dict[str, object]] = []

    def get(self, _url: str, **_kwargs) -> Response:
        return Response(200, self.current)

    def post(self, _url: str, **kwargs) -> Response:
        self.posts.append(kwargs)
        return Response(200)


def test_identical_payload_reuses_latest_version(monkeypatch) -> None:
    session = Session(b"same")
    monkeypatch.setattr(app, "compute_session", lambda: session)
    monkeypatch.setattr(app, "secret_path", lambda name: f"projects/p/secrets/{name}")

    changed = app.add_secret_version_if_changed(
        "example", b"same", error_message="save failed"
    )

    assert changed is False
    assert session.posts == []


def test_changed_payload_adds_exactly_one_version(monkeypatch) -> None:
    session = Session(b"old")
    monkeypatch.setattr(app, "compute_session", lambda: session)
    monkeypatch.setattr(app, "secret_path", lambda name: f"projects/p/secrets/{name}")

    changed = app.add_secret_version_if_changed(
        "example", b"new", error_message="save failed"
    )

    assert changed is True
    assert len(session.posts) == 1
    assert session.posts[0]["json"] == {
        "payload": {"data": base64.b64encode(b"new").decode("ascii")}
    }
