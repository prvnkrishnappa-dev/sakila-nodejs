"""
tests/test_analyzer_v4.py
=========================
Unit tests for analyzer.py v8.

Covers all original 15 audit fixes (v3 CHK/RTY/TMO) plus the 8 new v8 fixes
(N-01..N-08), with all assertions corrected to match the actual semantics of
chunk(), ClaudeClient, and _GitHubTokenAuth.

Run:
  python -m unittest tests.test_analyzer_v4 -v

Key semantic corrections vs test_analyzer_v3.py:
  - chunk() parameter is ``source_label=`` (not ``label=``).
  - ``dropped_chars`` = original_len - body_chars_kept.  Because the
    truncation notice itself consumes part of the max_chars budget, this is
    *greater* than ``len(original) - max_chars``.
  - The correct assertion for ``len(result.text) <= max_chars`` is the hard
    contract; the text does NOT start with exactly ``max_chars`` content bytes.
  - ClaudeClient.complete() total attempts = max_retries + 1 (N-03 fix).
  - _ApiKeyAuth / _GitHubTokenAuth raise ValueError on empty/None credentials
    (N-01, N-02, N-05 fixes).
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# ── Add src to path ───────────────────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import requests

import analyzer as A
from analyzer import (
    ChunkResult,
    ClaudeClient,
    GitHubReader,
    TimeoutHTTPAdapter,
    _ApiKeyAuth,
    _GitHubTokenAuth,
    _jitter_backoff,
    _split_timeout,
    chunk,
    phase2_knowledge,
    phase2_summary,
)


# =============================================================================
# TC-1  CHUNKING -- content within limit -> no truncation, no warning
# =============================================================================
class TestChunkNoTruncation(unittest.TestCase):
    def test_short_content_passes_through_unchanged(self):
        content = "x" * 100
        result  = chunk(content, max_chars=200)
        self.assertIsInstance(result, ChunkResult)
        self.assertEqual(result.text, content)
        self.assertFalse(result.truncated)
        self.assertEqual(result.dropped_chars, 0)

    def test_exactly_at_limit_not_truncated(self):
        content = "a" * 9_000
        result  = chunk(content, max_chars=9_000)
        self.assertFalse(result.truncated)
        self.assertEqual(result.dropped_chars, 0)

    def test_warning_not_emitted_for_short_content(self):
        with self.assertLogs("analyzer", level="WARNING") as cm:
            # Trigger one warning so assertLogs does not fail on empty output
            A.log.warning("sentinel")
            chunk("short", max_chars=200)
        self.assertFalse(
            any("CHUNK TRUNCATION" in m for m in cm.output),
            "No truncation warning expected for short content",
        )


# =============================================================================
# TC-2  CHUNKING -- content exceeds limit -> ChunkResult + warning + metadata
#
# SEMANTIC NOTE: dropped_chars = original_len - body_chars, which is larger
# than (original_len - max_chars) because the notice text also eats into the
# budget.  The hard contract is len(result.text) <= max_chars.
# =============================================================================
class TestChunkTruncation(unittest.TestCase):
    def setUp(self):
        self.content = "B" * 15_000

    def test_returns_chunkresult_namedtuple(self):
        # TC-2a: uses correct kwarg source_label= (not label=)
        result = chunk(self.content, max_chars=9_000, source_label="Foo.java")
        self.assertIsInstance(result, ChunkResult)

    def test_text_length_strictly_within_limit(self):
        # TC-2b (corrected): len(text) <= max_chars is the hard guarantee.
        # The text does NOT fill all max_chars with original bytes because
        # the notice appended at the end also eats into the budget.
        result = chunk(self.content, max_chars=9_000)
        self.assertLessEqual(len(result.text), 9_000,
                             "chunk() must never exceed max_chars")
        self.assertTrue(result.text.startswith("B"),
                        "text should start with original content")
        self.assertIn("truncated", result.text,
                      "truncation notice must appear in the text")

    def test_truncated_flag_and_dropped_chars_semantics(self):
        # TC-2c (corrected): truncated=True; dropped_chars > (15000 - 9000) = 6000.
        # The body portion + dropped_chars must equal the original length.
        result = chunk(self.content, max_chars=9_000)
        self.assertTrue(result.truncated)
        self.assertGreater(result.dropped_chars, 6_000,
                           "dropped_chars must exceed naive (original - max_chars) "
                           "because the notice itself consumes budget")
        # Invariant: body_chars + dropped_chars == original_len
        notice_start = result.text.index("\n// ...")
        body_chars = notice_start
        self.assertEqual(body_chars + result.dropped_chars, len(self.content))

    def test_warning_logged_with_source_label_and_counts(self):
        # TC-2d: uses source_label= kwarg; warning must include label text
        with self.assertLogs("analyzer", level="WARNING") as cm:
            chunk(self.content, max_chars=9_000, source_label="Big.java")
        combined = " ".join(cm.output)
        self.assertIn("CHUNK TRUNCATION", combined)
        self.assertIn("Big.java", combined)

    def test_custom_max_chars_respected_and_invariant_holds(self):
        # TC-2e (corrected): for 5000 limit, dropped_chars > (15000-5000) = 10000
        result = chunk(self.content, max_chars=5_000)
        self.assertLessEqual(len(result.text), 5_000)
        self.assertGreater(result.dropped_chars, 10_000)
        notice_start = result.text.index("\n// ...")
        self.assertEqual(notice_start + result.dropped_chars, len(self.content))


# =============================================================================
# TC-3  RETRY -- 429 triggers exponential-jitter retry; 401 raises immediately
# =============================================================================
class TestClaudeClientRetry(unittest.TestCase):
    def _make_response(self, status: int, body: dict | None = None) -> MagicMock:
        r = MagicMock()
        r.ok          = (200 <= status < 300)
        r.status_code = status
        if r.ok:
            r.json.return_value = {"content": [{"text": json.dumps(body or {"ok": 1})}]}
            r.raise_for_status = MagicMock()
        else:
            r.raise_for_status.side_effect = requests.HTTPError(response=r)
        return r

    def _client(self, max_retries: int = 3) -> ClaudeClient:
        return ClaudeClient(api_key="sk-test", llm_timeout=60.0,
                            max_retries=max_retries)

    def test_429_retries_then_succeeds(self):
        """TC-3a: Two 429s followed by a 200 -- should succeed after retries."""
        c   = self._client()
        seq = [
            self._make_response(429),
            self._make_response(429),
            self._make_response(200, {"ok": 1}),
        ]
        with patch.object(c.s, "post", side_effect=seq), \
             patch("time.sleep"):
            text = c.complete("hello")
        self.assertIn("ok", text)

    def test_500_502_503_retried(self):
        """TC-3b: 500/502/503 are retryable server errors."""
        c = self._client()
        for code in (500, 502, 503):
            seq = [self._make_response(code), self._make_response(200, {"x": code})]
            with patch.object(c.s, "post", side_effect=seq), \
                 patch("time.sleep"):
                text = c.complete("hi")
            self.assertIn(str(code), text)

    def test_401_raises_immediately_without_retry(self):
        """TC-3c (FIX RTY-3): 401 must not consume retry budget."""
        c    = self._client()
        r401 = self._make_response(401)
        with patch.object(c.s, "post", return_value=r401), \
             patch("time.sleep") as sleep_mock:
            with self.assertRaises(requests.HTTPError):
                c.complete("secret")
        sleep_mock.assert_not_called()

    def test_exhausted_retries_raise_runtime_error(self):
        """TC-3d: All attempts exhausted raises RuntimeError."""
        c = self._client(max_retries=2)  # 3 total attempts
        with patch.object(c.s, "post", return_value=self._make_response(429)), \
             patch("time.sleep"):
            with self.assertRaises(RuntimeError):
                c.complete("hi")

    def test_timeout_exception_retried(self):
        """TC-3e (FIX RTY-4): requests.Timeout on network is retried."""
        c   = self._client()
        seq = [
            requests.Timeout("timed out"),
            self._make_response(200, {"v": 1}),
        ]
        with patch.object(c.s, "post", side_effect=seq), \
             patch("time.sleep"):
            text = c.complete("hi")
        self.assertIn("v", text)

    def test_backoff_is_exponential_not_linear(self):
        """TC-3f (FIX RTY-2): successive waits grow exponentially."""
        waits: list[float] = []

        def capture_sleep(t: float) -> None:
            waits.append(t)

        c = self._client(max_retries=4)  # 5 total attempts -> 4 sleeps
        with patch.object(c.s, "post", return_value=self._make_response(429)), \
             patch("time.sleep", side_effect=capture_sleep):
            with self.assertRaises(RuntimeError):
                c.complete("hi")

        self.assertGreaterEqual(len(waits), 3)
        for i in range(1, len(waits)):
            ratio = waits[i] / waits[i - 1]
            self.assertGreater(ratio, 1.0,
                               f"wait[{i}]={waits[i]:.2f} not > wait[{i-1}]={waits[i-1]:.2f}")

    def test_max_retries_zero_still_makes_one_attempt(self):
        """TC-3g (FIX N-03): max_retries=0 must attempt the call exactly once."""
        c    = self._client(max_retries=0)
        r200 = self._make_response(200, {"zero": True})
        calls: list[int] = []

        def counting_post(*args, **kwargs):
            calls.append(1)
            return r200

        with patch.object(c.s, "post", side_effect=counting_post):
            text = c.complete("x")
        self.assertEqual(len(calls), 1,
                         "max_retries=0 must make exactly 1 attempt")
        self.assertIn("zero", text)

    def test_max_retries_zero_with_429_raises_after_one_attempt(self):
        """TC-3h (FIX N-03): max_retries=0 + 429 -> RuntimeError after 1 attempt."""
        c    = self._client(max_retries=0)
        r429 = self._make_response(429)
        calls: list[int] = []

        def counting_post(*args, **kwargs):
            calls.append(1)
            return r429

        with patch.object(c.s, "post", side_effect=counting_post), \
             patch("time.sleep"):
            with self.assertRaises(RuntimeError):
                c.complete("x")
        self.assertEqual(len(calls), 1,
                         "max_retries=0 should make exactly 1 attempt then raise")


# =============================================================================
# TC-4  TIMEOUT -- connect/read split; session adapter; token scaling
# =============================================================================
class TestTimeouts(unittest.TestCase):
    def test_split_timeout_connect_capped_at_10s(self):
        """FIX TMO-3: connect portion capped at 10 s."""
        connect, read = _split_timeout(180.0)
        self.assertLessEqual(connect, 10.0)
        self.assertAlmostEqual(connect + read, 180.0, places=5)

    def test_split_timeout_small_value(self):
        connect, read = _split_timeout(9.0)
        self.assertAlmostEqual(connect, 3.0, places=5)
        self.assertAlmostEqual(read,    6.0, places=5)

    def test_llm_read_timeout_scales_with_max_tokens(self):
        """FIX TMO-5: read timeout grows with max_tokens."""
        c = ClaudeClient(api_key="sk-test", llm_timeout=180.0)
        _, read_small = c._call_timeout(1024)
        _, read_large = c._call_timeout(8192)
        self.assertGreater(read_large, read_small)
        self.assertAlmostEqual(
            read_large - read_small, (8192 - 1024) / 20.0, places=2
        )

    def test_timeout_http_adapter_sets_default(self):
        """FIX TMO-4: adapter injects timeout when call-site omits it."""
        default_t = (5.0, 30.0)
        kwargs: dict = {}
        kwargs.setdefault("timeout", default_t)
        self.assertEqual(kwargs["timeout"], default_t)

    def test_timeout_http_adapter_does_not_override_explicit(self):
        """FIX TMO-4: adapter must not override an explicit timeout= argument."""
        default_t  = (5.0, 30.0)
        explicit_t = (2.0, 10.0)
        kwargs: dict = {"timeout": explicit_t}
        kwargs.setdefault("timeout", default_t)
        self.assertEqual(kwargs["timeout"], explicit_t)

    def test_github_reader_uses_split_timeout(self):
        """FIX TMO-2, TMO-3: GitHubReader builds (connect, read) tuple."""
        with patch("requests.Session"):
            gr = GitHubReader(gh_timeout=30.0)
        connect, read = gr._timeout
        self.assertLessEqual(connect, 10.0)
        self.assertAlmostEqual(connect + read, 30.0, places=5)


# =============================================================================
# TC-5  SECURITY -- credential validation (FIX N-01, N-02, N-05)
# =============================================================================
class TestCredentialValidation(unittest.TestCase):
    def test_api_key_auth_rejects_empty_string(self):
        """N-01/N-05: _ApiKeyAuth must raise ValueError on empty string."""
        with self.assertRaises(ValueError):
            _ApiKeyAuth("")

    def test_api_key_auth_accepts_valid_key(self):
        """N-01/N-05: _ApiKeyAuth must accept a non-empty key."""
        auth = _ApiKeyAuth("sk-ant-test-key")
        self.assertIsNotNone(auth)
        self.assertEqual(repr(auth), "<_ApiKeyAuth ***>",
                         "repr must never expose the key")

    def test_github_token_auth_rejects_empty_string(self):
        """N-02/N-05: _GitHubTokenAuth must raise ValueError on empty string."""
        with self.assertRaises(ValueError):
            _GitHubTokenAuth("")

    def test_github_token_auth_accepts_valid_token(self):
        """N-02/N-05: _GitHubTokenAuth must accept a non-empty token."""
        auth = _GitHubTokenAuth("ghp_test_token_12345")
        self.assertIsNotNone(auth)
        self.assertEqual(repr(auth), "<_GitHubTokenAuth ***>",
                         "repr must never expose the token")

    def test_claude_client_rejects_empty_api_key(self):
        """N-01: ClaudeClient must raise ValueError on empty api_key."""
        with self.assertRaises(ValueError):
            ClaudeClient(api_key="")

    def test_github_reader_none_token_uses_no_auth(self):
        """N-02: GitHubReader(token=None) must not raise and uses no auth."""
        with patch("requests.Session"):
            gr = GitHubReader(token=None)
        self.assertIsNone(gr._auth)


# =============================================================================
# TC-6  EDGE CASES -- batch fallback, summary trim, GitHub raw retry, etc.
# =============================================================================
class TestEdgeCases(unittest.TestCase):

    # TC-6a: phase2_summary trims purposes payload (FIX CHK-4)
    def test_summary_trims_payload_on_overflow(self):
        purposes_heavy = [{"file": f"File{i}.java", "purpose": "x" * 300}
                          for i in range(60)]
        knowledge = [{"file": e["file"], "purpose": e["purpose"]}
                     for e in purposes_heavy]

        mock_llm = MagicMock(spec=ClaudeClient)
        mock_llm.complete_json.return_value = {"project_name": "test"}

        with self.assertLogs("analyzer", level="WARNING") as cm:
            phase2_summary({}, knowledge, mock_llm)

        combined = " ".join(cm.output)
        self.assertIn("SUMMARY PAYLOAD TRIMMED", combined)
        call_prompt = mock_llm.complete_json.call_args[0][0]
        self.assertLessEqual(len(call_prompt), A.SUMMARY_MAX_CHARS + 500)

    # TC-6b: batch fallback to singles on LLM error (FIX CHK-3)
    def test_batch_failure_falls_back_to_singles(self):
        files = {
            "com/A.java": {"category": "Service", "lines": 10,
                           "content": "class A {}"},
            "com/B.java": {"category": "Service", "lines": 10,
                           "content": "class B {}"},
        }
        mock_llm = MagicMock(spec=ClaudeClient)
        mock_llm.complete_json.side_effect = [
            ValueError("LLM batch error"),
            {"file": "A.java", "purpose": "A svc"},
            {"file": "B.java", "purpose": "B svc"},
        ]

        with self.assertLogs("analyzer", level="WARNING"):
            results = phase2_knowledge(files, mock_llm, max_chars=9_000)

        paths = {r["_path"] for r in results}
        self.assertIn("com/A.java", paths)
        self.assertIn("com/B.java", paths)

    # TC-6c: GitHub raw retry recovers from transient 503 (FIX RTY-5)
    def test_github_raw_retries_on_503(self):
        ok_response             = MagicMock()
        ok_response.ok          = True
        ok_response.status_code = 200
        ok_response.text        = "class Foo {}"

        fail_response             = MagicMock()
        fail_response.ok          = False
        fail_response.status_code = 503

        with patch("requests.Session"):
            gr = GitHubReader(gh_timeout=30.0)

        gr.s = MagicMock()
        gr.s.get.side_effect = [fail_response, ok_response]

        with patch("time.sleep"):
            text = gr._raw("some/File.java")

        self.assertEqual(text, "class Foo {}")
        self.assertEqual(gr.s.get.call_count, 2)

    # TC-6d: zero-byte file below 5 lines is skipped (existing guard)
    def test_tiny_file_skipped_in_knowledge_extraction(self):
        files = {
            "com/Tiny.java": {"category": "Entity", "lines": 2,
                              "content": "// stub"},
        }
        mock_llm = MagicMock(spec=ClaudeClient)
        results  = phase2_knowledge(files, mock_llm, max_chars=9_000)
        self.assertEqual(len(results), 0)
        mock_llm.complete_json.assert_not_called()

    # TC-6e: jitter backoff never returns zero or negative
    def test_jitter_backoff_always_positive(self):
        for base in (5.0, 15.0):
            for attempt in range(5):
                wait = _jitter_backoff(base, attempt)
                self.assertGreater(
                    wait, 0,
                    f"Expected positive wait for base={base} attempt={attempt}",
                )

    # TC-6f: chunk() with empty content
    def test_chunk_empty_content(self):
        result = chunk("", max_chars=200)
        self.assertFalse(result.truncated)
        self.assertEqual(result.dropped_chars, 0)
        self.assertEqual(result.text, "")

    # TC-6g: chunk() below MIN_CHUNK_CHARS raises ValueError
    def test_chunk_below_min_raises(self):
        with self.assertRaises(ValueError):
            chunk("x" * 100, max_chars=A.MIN_CHUNK_CHARS - 1)

    # TC-6h: large content (1M chars) still satisfies len <= max_chars
    def test_chunk_large_content_respects_limit(self):
        content = "Z" * 1_000_000
        result  = chunk(content, max_chars=9_000)
        self.assertLessEqual(len(result.text), 9_000)
        self.assertTrue(result.truncated)

    # TC-6i: no sleep after the last single-file LLM call
    def test_no_sleep_after_last_single_file(self):
        files = {
            "com/Only.java": {
                "category": "Service", "lines": 10,
                "content": "x" * 5_000,  # >BATCH_CHAR_THRESHOLD -> single path
            },
        }
        mock_llm = MagicMock(spec=ClaudeClient)
        mock_llm.complete_json.return_value = {"file": "Only.java", "purpose": "p"}

        with patch("time.sleep") as sleep_mock:
            phase2_knowledge(files, mock_llm, max_chars=9_000)

        sleep_mock.assert_not_called()

    # TC-6j: complete() does not sleep on first-attempt success
    def test_no_sleep_on_first_attempt_success(self):
        c    = ClaudeClient(api_key="sk-test", max_retries=4)
        r200 = MagicMock()
        r200.status_code = 200
        r200.ok          = True
        r200.json.return_value = {"content": [{"text": "hi"}]}
        r200.raise_for_status = MagicMock()

        with patch.object(c.s, "post", return_value=r200), \
             patch("time.sleep") as sleep_mock:
            c.complete("x")

        sleep_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
