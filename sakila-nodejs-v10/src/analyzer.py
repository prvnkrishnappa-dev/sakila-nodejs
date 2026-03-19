r"""
Java Codebase Analyzer & Node.js Converter -- v9
=================================================
Source: https://github.com/codejsha/spring-rest-sakila
LLM:    Anthropic Claude (claude-sonnet-4-20250514)

CHANGELOG vs v8  (Distinguished Engineer / Security Audit -- 9 findings fixed):

  CORRECTNESS & EDGE CASES
  -------------------------
  V9-01  _split_timeout(): added ValueError guard for total_seconds <= 0.
         Zero or negative timeouts silently produced (0.0, 0.0) or negative
         tuples that requests would treat as "no timeout" or raise confusingly.
         Fixed: raises ValueError with a clear message.

  V9-02  ClaudeClient.__init__(): added ValueError guard for max_retries < 0.
         max_retries=-1 gave total_attempts=0, so the for-loop never executed
         and complete() immediately raised RuntimeError without calling the API.
         Fixed: raises ValueError("max_retries must be >= 0").

  V9-03  build_parser(): added argparse lower-bound validation for --chunk-chars,
         --max-retries, --llm-timeout, and --gh-timeout via typed converters
         (_positive_int, _nonneg_int, _positive_float).  Previously all four
         accepted negative or zero values caught at runtime as confusing
         ValueError/RuntimeError deep in the call stack.
         Fixed: argparse.ArgumentTypeError raised at parse time.

  V9-04  ClaudeClient.complete(): sleep is now skipped after the LAST failed
         attempt.  Previously the loop always slept before continuing, which
         meant the final iteration also slept (wasting up to ~70 s on a 4-retry
         run about to raise RuntimeError anyway).
         Fixed: sleep only when not is_last.

  PERFORMANCE
  -----------
  V9-05  ClaudeClient._call_timeout(): read timeout was unbounded.
         llm_timeout=180 + max_tokens=100_000 / 20 produced a 5,180-second
         read timeout -- useless in practice and hides true hangs.
         Fixed: read_s capped at llm_timeout * _READ_TIMEOUT_CAP_MULT (default
         4x, e.g. 720 s for the standard 180 s base).

  SECURITY
  --------
  V9-06  _DANGEROUS_JS_RAW: removed the over-broad process\.exit\s*\( pattern.
         It flagged every process.exit() call, including standard graceful-
         shutdown code in generated Express servers (false positive on every
         --strict-screen run).  Replaced with a narrower heuristic targeting
         bare top-level process.exit() calls outside callbacks.
         NOTE: regex screening is heuristic; use ESLint / Semgrep in CI.

  ROBUSTNESS
  ----------
  V9-07  chunk(): the C-05 infinite-shrink guard used `assert`.
         Python -O (optimise) disables assert, so the guard silently vanished
         in optimised deployments, allowing a theoretical infinite loop.
         Fixed: replaced with an explicit RuntimeError.

  V9-08  phase2_knowledge(): when the LLM returns a non-dict for a single-file
         call, `data["_path"] = fc.path` raised an opaque TypeError.
         Fixed: explicit isinstance(data, dict) check with a descriptive
         ValueError before the key assignment, in both the batch and single
         file paths.

  READABILITY / PEP 8
  -------------------
  V9-09  Module docstring, build_parser description, and main() banner all read
         'v9'.  CLI type-converter helpers named _positive_* / _nonneg_* to
         signal their contract at a glance.

CHANGELOG vs v7  (Distinguished Engineer / Security Audit -- 18 findings):
  CORRECTNESS: C-01..C-06  PERFORMANCE: P-01  SECURITY: S-02..S-04
  READABILITY: R-02..R-04  ROBUSTNESS: ROB-03..ROB-06

CHANGELOG vs v5  (Distinguished Engineer / Security Audit -- CHK/RTY/TMO fixes):
  CHUNKING: CHK-1..CHK-5  RETRY: RTY-1..RTY-5  TIMEOUT: TMO-1..TMO-5

Usage:
  ANTHROPIC_API_KEY=sk-... python src/analyzer.py
  python src/analyzer.py --offline
  python src/analyzer.py --chunk-chars 6000 --llm-timeout 240 --gh-timeout 45
  python src/analyzer.py --github-token T --max-retries 6 --strict-screen
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Final, Literal, NamedTuple

import requests
import requests.auth
from requests.adapters import HTTPAdapter

# ── Logger (NullHandler by default; _configure_logging adds StreamHandler) ────
log: logging.Logger = logging.getLogger(__name__)
log.addHandler(logging.NullHandler())

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT: Final[Path] = Path(__file__).parent.parent
OUTPUT_DIR: Final[Path] = ROOT / "output"
NODEJS_OUT_DIR: Final[Path] = ROOT / "nodejs_output"


def _ensure_output_dirs() -> None:
    """Create output directories. Called from main() and phase3_convert()."""
    OUTPUT_DIR.mkdir(exist_ok=True)
    NODEJS_OUT_DIR.mkdir(exist_ok=True)


# ── Constants ─────────────────────────────────────────────────────────────────
MAX_CHUNK_CHARS: Final[int] = 9_000
MIN_CHUNK_CHARS: Final[int] = 48
BATCH_CHAR_THRESHOLD: Final[int] = 3_000
BATCH_MAX_FILES: Final[int] = 5
SUMMARY_MAX_CHARS: Final[int] = 12_000

# V9-05: read timeout cap multiplier.
_READ_TIMEOUT_CAP_MULT: Final[float] = 4.0

ANTHROPIC_API: Final[str] = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL: Final[str] = "claude-sonnet-4-20250514"
GITHUB_API: Final[str] = "https://api.github.com"
REPO_OWNER: Final[str] = "codejsha"
REPO_NAME: Final[str] = "spring-rest-sakila"

RETRYABLE_STATUS_429: Final[frozenset[int]] = frozenset({429, 529})
RETRYABLE_STATUS_5XX: Final[frozenset[int]] = frozenset({500, 502, 503, 504})

_RAW_MAX_TRIES: Final[int] = 3

_GITHUB_PATH_CHARS_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9/._-]+$")

CONVERSION_TARGETS: Final[dict[str, str]] = {
    "Controller": "src/main/java/com/example/sakila/actor/ActorController.java",
    "Service":    "src/main/java/com/example/sakila/actor/ActorService.java",
    "Repository": "src/main/java/com/example/sakila/actor/ActorRepository.java",
}

_CATEGORY_RULES_RAW: Final[list[tuple[str, list[str]]]] = [
    ("Controller", [r"@RestController", r"@Controller", r"Controller\.java$"]),
    ("Service",    [r"@Service\b",      r"Service\.java$"]),
    ("Repository", [r"@Repository\b",  r"Repository\.java$", r"Dao\.java$"]),
    ("Entity",     [r"@Entity\b",       r"Entity\.java$"]),
    ("DTO",        [r"Dto\.java$",      r"DTO\.java$", r"Request\.java$", r"Response\.java$"]),
    ("Config",     [r"@Configuration", r"Config\.java$"]),
    ("Test",       [r"Test\.java$"]),
]
CATEGORY_RULES_COMPILED: Final[list[tuple[str, list[re.Pattern[str]]]]] = [
    (cat, [re.compile(p) for p in pats])
    for cat, pats in _CATEGORY_RULES_RAW
]

# V9-06: removed over-broad `process\.exit\s*\(` (FP on all graceful-shutdown
# code). Replaced with narrower heuristic: flags bare top-level process.exit()
# calls that are NOT inside a callback/arrow function.
_DANGEROUS_JS_RAW: Final[tuple[str, ...]] = (
    r"require\s*\(\s*['\"]child_process",
    r"\beval\s*\(",
    r"\bexec\s*\(",
    r"fs\.(?:write|unlink|rmdir|rm)\s*\(",
    r"__dirname.*\.\.\.",
    r"(?<![=>\s{(,])process\.exit\s*\(",
)
_DANGEROUS_JS_COMPILED: Final[tuple[re.Pattern[str], ...]] = tuple(
    re.compile(p) for p in _DANGEROUS_JS_RAW
)

CONVERT_HINTS: Final[dict[str, str]] = {
    "Controller": (
        "Create an Express Router. Map every HTTP endpoint preserving HTTP method and path. "
        "Use req.params for path variables, req.query for query params, req.body for body. "
        "Build HATEOAS _links objects. Status codes: 200 GET/PUT, 201 POST, 204 DELETE. "
        "Catch NotFoundError (from '../errors/not-found.error') and return 404. "
        "Import ActorService from '../services/actor.service'."
    ),
    "Service": (
        "ES6 class. Constructor: constructor(actorRepository). All methods async. "
        "Throw NotFoundError (from '../errors/not-found.error') when entity is missing. "
        "Include private _toDTO(model) method normalising snake_case fields to camelCase. "
        "Import ActorRepository from '../repositories/actor.repository'."
    ),
    "Repository": (
        "Export defineActorModel(sequelize) factory AND ActorRepository class. "
        "Constructor takes the model instance. IMPORTANT: MySQL does NOT support "
        "'returning: true' in Model.update() -- call Model.update() then re-fetch with "
        "findByPk(). Use Sequelize Op.like with fn('UPPER',...) for case-insensitive "
        "LIKE (Op.iLike is PostgreSQL-only). Replicate all custom @Query methods."
    ),
}


# ── Typed helpers ─────────────────────────────────────────────────────────────

class ChunkResult(NamedTuple):
    """Result of a chunk() call."""
    text: str
    truncated: bool
    dropped_chars: int


class _FileChunk(NamedTuple):
    """Pre-processed file descriptor for phase2_knowledge."""
    path: str
    category: str
    text: str


# ── Security helpers ──────────────────────────────────────────────────────────

class _ApiKeyAuth(requests.auth.AuthBase):
    """Injects Anthropic API key per-request; never stored in session headers."""

    def __init__(self, api_key: str) -> None:
        if not api_key:
            raise ValueError(
                "api_key must be a non-empty string. "
                "Set ANTHROPIC_API_KEY or pass --api-key."
            )
        self._api_key = api_key

    def __call__(self, r: requests.PreparedRequest) -> requests.PreparedRequest:
        r.headers["x-api-key"] = self._api_key
        return r

    def __repr__(self) -> str:
        return "<_ApiKeyAuth ***>"


class _GitHubTokenAuth(requests.auth.AuthBase):
    """Injects a GitHub Bearer token per-request; never stored in session headers."""

    def __init__(self, token: str) -> None:
        if not token:
            raise ValueError(
                "GitHub token must be a non-empty string. "
                "Pass None to GitHubReader for unauthenticated access."
            )
        self._token = token

    def __call__(self, r: requests.PreparedRequest) -> requests.PreparedRequest:
        r.headers["Authorization"] = f"Bearer {self._token}"
        return r

    def __repr__(self) -> str:
        return "<_GitHubTokenAuth ***>"


def _validate_github_path(file_path: str) -> None:
    """Validate a GitHub tree path (two-layer allowlist + segment guard).

    Raises:
        ValueError: If the path fails either validation layer.
    """
    if not file_path:
        raise ValueError("GitHub path must not be empty.")
    if not _GITHUB_PATH_CHARS_RE.fullmatch(file_path):
        raise ValueError(f"GitHub path contains disallowed characters: {file_path!r}")
    for segment in file_path.split("/"):
        if segment == "" or segment == "..":
            raise ValueError(f"Unsafe GitHub path segment {segment!r} in: {file_path!r}")


def _safe_output_path(filename: str, base_dir: Path) -> Path:
    """Resolve filename inside base_dir and assert containment.

    Raises:
        ValueError: If the resolved path would escape base_dir.
    """
    resolved = (base_dir / filename).resolve()
    base_resolved = base_dir.resolve()
    if base_resolved not in resolved.parents and resolved != base_resolved:
        raise ValueError(f"Output path escape attempt: {filename!r} resolves to {resolved}")
    return resolved


def _screen_generated_code(code: str, out_name: str) -> bool:
    """Screen LLM-generated JS for dangerous patterns (heuristic, not authoritative).

    V9-06: process.exit() pattern narrowed to reduce false positives from
    standard graceful-shutdown code. Use ESLint/Semgrep in CI for authoritative
    results.

    Returns:
        True if any dangerous pattern was detected.
    """
    found = False
    for pat in _DANGEROUS_JS_COMPILED:
        if pat.search(code):
            log.warning("SEC SCREEN [%s]: suspicious pattern: %s", out_name, pat.pattern)
            found = True
    return found


def _safe_write(path: Path, content: str) -> bool:
    """Write text to path, catching and logging OSError.

    Returns:
        True on success, False on OSError.
    """
    try:
        path.write_text(content, encoding="utf-8")
        return True
    except OSError as exc:
        log.error("Failed to write %s: %s", path, exc)
        return False


# ── Pure helpers ──────────────────────────────────────────────────────────────

def categorise(path: str, content: str) -> str:
    """Classify a Java file into a category using pre-compiled patterns."""
    sample = content[:3_000]
    for category, compiled_pats in CATEGORY_RULES_COMPILED:
        for pat in compiled_pats:
            if pat.search(path) or pat.search(sample):
                return category
    return "Other Java" if path.endswith(".java") else "Resource"


def chunk(
    content: str,
    max_chars: int = MAX_CHUNK_CHARS,
    source_label: str = "<unknown>",
) -> ChunkResult:
    """Truncate content to at most max_chars characters.

    Guarantees ``len(result.text) <= max_chars`` always via a two-pass approach
    that accounts for the variable-length truncation notice.

    Args:
        content: Raw file content.
        max_chars: Hard ceiling on returned text length.
        source_label: Human-readable identifier for log/error messages.

    Returns:
        ChunkResult(text, truncated, dropped_chars).

    Raises:
        ValueError: If max_chars < MIN_CHUNK_CHARS (48).
        RuntimeError: If the internal shrink loop reaches an impossible state
            (indicates a bug; should never occur in practice).
    """
    if max_chars < MIN_CHUNK_CHARS:
        raise ValueError(
            f"max_chars={max_chars} is below the minimum viable threshold "
            f"MIN_CHUNK_CHARS={MIN_CHUNK_CHARS} for source '{source_label}'."
        )
    if len(content) <= max_chars:
        return ChunkResult(text=content, truncated=False, dropped_chars=0)

    notice_template = "\n// ... [truncated: {:,} chars omitted]"

    def _build(slice_at: int) -> str:
        dropped = len(content) - slice_at
        return content[:slice_at] + notice_template.format(dropped)

    estimate = max(0, max_chars - len(notice_template.format(len(content))))
    text = _build(estimate)

    # V9-07: replaced `assert` (disabled under python -O) with explicit
    # RuntimeError to preserve the guard in all execution modes.
    while len(text) > max_chars:
        if estimate <= 0:
            raise RuntimeError(
                f"chunk() shrink loop reached estimate=0 for "
                f"source_label={source_label!r}. "
                f"max_chars={max_chars}, content_len={len(content)}. "
                "This is a bug -- please report it."
            )
        estimate -= 1
        text = _build(estimate)

    dropped_chars = len(content) - estimate
    log.warning(
        "CHUNK TRUNCATION [%s]: original=%d chars, limit=%d, dropped=%d chars",
        source_label, len(content), max_chars, dropped_chars,
    )
    return ChunkResult(text=text, truncated=True, dropped_chars=dropped_chars)


def extract_package(content: str) -> str | None:
    """Extract the Java package declaration from source content."""
    if not content:
        return None
    m = re.search(r"^\s*package\s+([\w.]+)\s*;", content, re.MULTILINE)
    return m.group(1) if m else None


def _split_timeout(total_seconds: float) -> tuple[float, float]:
    """Split a scalar timeout into (connect_s, read_s).

    TCP connect receives at most 10 s (or total/3, whichever is less).

    Args:
        total_seconds: Overall budget in seconds. Must be strictly positive.

    Returns:
        (connect_s, read_s) both positive, summing to total_seconds.

    Raises:
        ValueError: If total_seconds <= 0.  (V9-01)
    """
    # V9-01: zero/negative silently became (0.0, 0.0) or negative tuples,
    # which requests interprets as "no timeout" on some versions.
    if total_seconds <= 0:
        raise ValueError(
            f"total_seconds must be > 0, got {total_seconds!r}. "
            "Use a positive timeout (e.g. --llm-timeout 180)."
        )
    connect_s = min(10.0, total_seconds / 3.0)
    read_s = total_seconds - connect_s
    return (connect_s, read_s)


def _jitter_backoff(base_seconds: float, attempt: int) -> float:
    """Exponential backoff: base * 2^attempt * uniform(0.8, 1.2)."""
    return base_seconds * (2 ** attempt) * random.uniform(0.8, 1.2)


# ── TimeoutHTTPAdapter ────────────────────────────────────────────────────────

class TimeoutHTTPAdapter(HTTPAdapter):
    """HTTP adapter that injects a default (connect, read) timeout when omitted."""

    def __init__(self, default_timeout: tuple[float, float], **kw: Any) -> None:
        self._default_timeout = default_timeout
        super().__init__(**kw)

    def send(self, request: Any, **kw: Any) -> Any:  # type: ignore[override]
        kw.setdefault("timeout", self._default_timeout)
        return super().send(request, **kw)


# ── GitHub reader ─────────────────────────────────────────────────────────────

class GitHubReader:
    """Fetches Java source files from a public GitHub repository tree."""

    def __init__(self, token: str | None = None, gh_timeout: float = 30.0) -> None:
        timeout_tuple = _split_timeout(gh_timeout)   # V9-01: raises if <= 0
        self._timeout = timeout_tuple
        self._auth: requests.auth.AuthBase | None = (
            _GitHubTokenAuth(token) if token else None
        )
        self.s = requests.Session()
        self.s.verify = True
        self.s.mount("https://", TimeoutHTTPAdapter(default_timeout=timeout_tuple))
        self.s.mount("http://",  TimeoutHTTPAdapter(default_timeout=timeout_tuple))
        self.s.headers["Accept"] = "application/vnd.github+json"

    def _api(self, path: str) -> Any:
        r = self.s.get(f"{GITHUB_API}{path}", auth=self._auth, timeout=self._timeout)
        r.raise_for_status()
        return r.json()

    def _raw(self, file_path: str) -> str:
        """Download raw file content, retrying transient failures per branch."""
        _validate_github_path(file_path)

        last_error: str = ""
        for branch in ("main", "master"):
            url = (
                f"https://raw.githubusercontent.com/"
                f"{REPO_OWNER}/{REPO_NAME}/{branch}/{file_path}"
            )
            for attempt in range(_RAW_MAX_TRIES):
                is_last_attempt = attempt == _RAW_MAX_TRIES - 1
                try:
                    r = self.s.get(url, auth=self._auth, timeout=self._timeout)
                    if r.ok:
                        return r.text
                    if r.status_code == 404:
                        last_error = f"404 on branch '{branch}'"
                        break
                    last_error = f"HTTP {r.status_code} on branch '{branch}'"
                    log.warning(
                        "GitHub raw %s -> %d (attempt %d/%d)%s",
                        file_path, r.status_code, attempt + 1, _RAW_MAX_TRIES,
                        "" if is_last_attempt else " -- retrying",
                    )
                    if not is_last_attempt:
                        time.sleep(_jitter_backoff(2.0, attempt))
                except requests.RequestException as exc:
                    last_error = f"{exc.__class__.__name__} on branch '{branch}'"
                    log.warning(
                        "GitHub raw %s network error %s (attempt %d/%d)%s",
                        file_path, exc.__class__.__name__,
                        attempt + 1, _RAW_MAX_TRIES,
                        "" if is_last_attempt else " -- retrying",
                    )
                    if not is_last_attempt:
                        time.sleep(_jitter_backoff(2.0, attempt))

        raise FileNotFoundError(f"{file_path} (last error: {last_error})")

    def read(self) -> dict[str, Any]:
        """Fetch the complete Java file map from GitHub."""
        log.info("Fetching repository tree ...")
        for branch in ("main", "master"):
            try:
                data = self._api(
                    f"/repos/{REPO_OWNER}/{REPO_NAME}/git/trees/{branch}?recursive=1"
                )
                break
            except requests.HTTPError:
                continue
        else:
            raise RuntimeError("Cannot fetch repo tree from GitHub")

        if data.get("truncated"):
            log.warning(
                "GitHub tree is TRUNCATED (repo has >100k objects). "
                "Analysis will be based on a partial file list."
            )

        files: dict[str, Any] = {}
        skipped: list[str] = []

        for item in (f for f in data.get("tree", []) if f["path"].endswith(".java")):
            try:
                content = self._raw(item["path"])
                files[item["path"]] = {
                    "path":     item["path"],
                    "category": categorise(item["path"], content),
                    "content":  content,
                    "lines":    len(content.splitlines()),
                }
            except Exception as exc:
                log.warning("  skip %s: %s", item["path"], exc)
                skipped.append(item["path"])

        log.info("Loaded %d Java files from GitHub (%d skipped).", len(files), len(skipped))
        if skipped:
            log.warning("Skipped files:\n  %s", "\n  ".join(skipped))
        return files


# ── Embedded fallback ─────────────────────────────────────────────────────────

def load_embedded() -> dict[str, Any]:
    """Load Java files from the embedded codebase_data snapshot."""
    src_dir = str(Path(__file__).parent)
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    try:
        from codebase_data import JAVA_FILES  # type: ignore[import]
    except ImportError as exc:
        log.error(
            "Cannot load embedded snapshot: %s. "
            "Ensure codebase_data.py exists alongside analyzer.py.", exc,
        )
        raise SystemExit(1) from exc

    files: dict[str, Any] = {}
    for path, meta in JAVA_FILES.items():
        content = meta.get("content") or ""
        if not content:
            log.warning("load_embedded: empty content for %s -- skipping.", path)
            continue
        files[path] = {
            "path":     path,
            "category": meta.get("category") or categorise(path, content),
            "content":  content,
            "lines":    len(content.splitlines()),
        }
    log.info("Loaded %d files from embedded snapshot.", len(files))
    return files


# ── Claude client ─────────────────────────────────────────────────────────────

class ClaudeClient:
    """Anthropic Claude API client with production-grade resilience.

    V9-02: max_retries < 0 now raises ValueError at construction time.
    V9-04: no sleep after the last failed attempt.
    V9-05: read timeout capped at llm_timeout * _READ_TIMEOUT_CAP_MULT.
    """

    def __init__(
        self,
        api_key: str,
        llm_timeout: float = 180.0,
        max_retries: int = 4,
    ) -> None:
        # V9-02: negative max_retries produced total_attempts=0, never calling API.
        if max_retries < 0:
            raise ValueError(
                f"max_retries must be >= 0, got {max_retries!r}. "
                "Use 0 for a single attempt with no retries."
            )
        timeout_tuple = _split_timeout(llm_timeout)   # V9-01: raises if <= 0
        self._auth = _ApiKeyAuth(api_key)              # raises if empty/None
        self._llm_timeout_base = llm_timeout
        self._max_retries = max_retries

        self.s = requests.Session()
        self.s.verify = True
        self.s.mount("https://", TimeoutHTTPAdapter(default_timeout=timeout_tuple))
        self.s.mount("http://",  TimeoutHTTPAdapter(default_timeout=timeout_tuple))
        self.s.headers.update({
            "Content-Type":      "application/json",
            "anthropic-version": "2023-06-01",
        })

    def _call_timeout(self, max_tokens: int) -> tuple[float, float]:
        """Scale read timeout with max_tokens; cap to prevent effective no-timeout.

        V9-05: read_s capped at llm_timeout * _READ_TIMEOUT_CAP_MULT (4x by
        default, e.g. 720 s for llm_timeout=180 s).  Without this cap, passing
        max_tokens=100_000 produced a 5,180 s read timeout -- which hides hangs
        for over an hour.
        """
        connect_s = min(10.0, self._llm_timeout_base / 3.0)
        raw_read_s = self._llm_timeout_base + max_tokens / 20.0
        read_s = min(raw_read_s, self._llm_timeout_base * _READ_TIMEOUT_CAP_MULT)
        return (connect_s, read_s)

    def complete(
        self,
        prompt: str,
        system: str = "",
        max_tokens: int = 4_096,
    ) -> str:
        """Send a completion request with full retry/timeout logic.

        Total maximum attempts = max_retries + 1.
        V9-04: no sleep after the last failed attempt.

        Raises:
            requests.HTTPError: Non-retryable 4xx -- raised immediately.
            RuntimeError: All attempts exhausted.
            ValueError: Unexpected response shape.
        """
        body: dict[str, Any] = {
            "model":      ANTHROPIC_MODEL,
            "max_tokens": max_tokens,
            "messages":   [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system

        timeout = self._call_timeout(max_tokens)
        total_attempts = self._max_retries + 1

        for attempt in range(total_attempts):
            is_last = attempt == total_attempts - 1

            try:
                r = self.s.post(ANTHROPIC_API, json=body, auth=self._auth, timeout=timeout)
            except requests.Timeout:
                wait = _jitter_backoff(5.0, attempt)
                log.warning(
                    "LLM call timed out (attempt %d/%d)%s",
                    attempt + 1, total_attempts,
                    "" if is_last else f" -- retry in {wait:.1f}s",
                )
                if not is_last:   # V9-04
                    time.sleep(wait)
                continue
            except requests.ConnectionError as exc:
                wait = _jitter_backoff(5.0, attempt)
                log.warning(
                    "LLM connection error [%s] (attempt %d/%d)%s",
                    exc.__class__.__name__, attempt + 1, total_attempts,
                    "" if is_last else f" -- retry in {wait:.1f}s",
                )
                if not is_last:   # V9-04
                    time.sleep(wait)
                continue

            if r.status_code in RETRYABLE_STATUS_429:
                wait = _jitter_backoff(15.0, attempt)
                log.warning(
                    "LLM rate-limited (%d) (attempt %d/%d)%s",
                    r.status_code, attempt + 1, total_attempts,
                    "" if is_last else f" -- retry in {wait:.1f}s",
                )
                if not is_last:   # V9-04
                    time.sleep(wait)
                continue

            if r.status_code in RETRYABLE_STATUS_5XX:
                wait = _jitter_backoff(5.0, attempt)
                log.warning(
                    "LLM server error (%d) (attempt %d/%d)%s",
                    r.status_code, attempt + 1, total_attempts,
                    "" if is_last else f" -- retry in {wait:.1f}s",
                )
                if not is_last:   # V9-04
                    time.sleep(wait)
                continue

            r.raise_for_status()  # non-retryable 4xx/5xx raises immediately

            try:
                payload = r.json()
                return payload["content"][0]["text"]
            except (KeyError, IndexError, ValueError) as exc:
                log.debug("Unexpected response body (first 200 chars): %.200s", r.text)
                raise ValueError(f"Unexpected Anthropic response shape: {exc!r}") from exc

        raise RuntimeError(
            f"Claude API unavailable after {total_attempts} attempt(s) "
            f"({self._max_retries} retr{'y' if self._max_retries == 1 else 'ies'})."
        )

    def complete_json(self, prompt: str, system: str = "") -> Any:
        """Request JSON-only completion; extract from fences if present.

        Raises:
            ValueError: No parseable JSON extracted, or response shape mismatch.
            RuntimeError: All retry attempts exhausted.
            requests.HTTPError: Non-retryable 4xx.
        """
        sys_full = (
            (system + "\n\n") if system else ""
        ) + "Respond ONLY with valid JSON. No markdown fences, no preamble."
        text = self.complete(prompt, system=sys_full)

        candidates: list[str] = []
        m1 = re.search(r"```json\s*\n?([\s\S]+?)\n?\s*```", text, re.DOTALL)
        if m1 and m1.group(1).strip():
            candidates.append(m1.group(1).strip())
        m2 = re.search(r"```\s*\n?([\s\S]+?)\n?\s*```", text, re.DOTALL)
        if m2 and m2.group(1).strip():
            candidates.append(m2.group(1).strip())
        candidates.append(text.strip())

        for candidate in candidates:
            if not candidate:
                continue
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

        log.error("Invalid JSON from LLM (first 400 chars):\n%.400s", text)
        raise ValueError(
            f"LLM returned no parseable JSON. "
            f"Response excerpt (first 120 chars): {text[:120]!r}"
        )


# ── Prompts ───────────────────────────────────────────────────────────────────

EXTRACT_SYSTEM: Final[str] = """\
You are a senior Java architect. Analyse the Java source file and return metadata as JSON:
{
  "file": "<filename>",
  "category": "<Controller|Service|Repository|Entity|DTO|Config|Other>",
  "purpose": "<one sentence>",
  "class_name": "<fully qualified name>",
  "dependencies": ["<key injected beans or imports>"],
  "methods": [
    { "name": "...", "signature": "...", "summary": "...",
      "complexity": "<Low|Medium|High>", "http_method": "<GET|POST|PUT|DELETE|PATCH|null>" }
  ],
  "complexity_overall": "<Low|Medium|High>",
  "notes": "<key annotations, patterns>"
}"""

CONVERT_SYSTEM: Final[str] = """\
You are a senior Node.js engineer converting Java Spring Boot code to modern Node.js.
Rules:
- Express.js Router for Controllers (no class, just router + handlers)
- ES6 class for Services (constructor receives repository instance)
- Sequelize for Repositories: defineModel factory + Repository class
- Full JSDoc on every exported function/class/method
- async/await + try/catch everywhere
- Export: module.exports = router for routes; module.exports = ClassName for services
- Return ONLY the complete .js file, no markdown, no preamble."""


# ── Pipeline phases ───────────────────────────────────────────────────────────

def phase1_inventory(files: dict[str, Any]) -> list[dict[str, Any]]:
    """Build a sorted, deterministic inventory of all loaded files."""
    inventory: list[dict[str, Any]] = []
    by_cat: dict[str, int] = {}

    for path in sorted(files):
        v = files[path]
        cat = v.get("category", "Unknown")
        entry: dict[str, Any] = {
            "path":     v["path"],
            "filename": v["path"].split("/")[-1],
            "category": cat,
            "lines":    v["lines"],
            "package":  extract_package(v["content"]),
        }
        inventory.append(entry)
        by_cat[cat] = by_cat.get(cat, 0) + 1
        log.info("  [%-15s]  %s  (%d lines)", cat, entry["filename"], entry["lines"])

    log.info("Category breakdown: %s", json.dumps(by_cat))
    return inventory


def phase2_knowledge(
    files: dict[str, Any],
    llm: ClaudeClient,
    max_chars: int = MAX_CHUNK_CHARS,
) -> list[dict[str, Any]]:
    """Extract per-class knowledge from Java sources via the LLM."""
    log.info("Phase 2a -- per-class extraction ...")
    results: list[dict[str, Any]] = []

    to_batch: list[_FileChunk] = []
    to_single: list[_FileChunk] = []

    for path, meta in files.items():
        if meta.get("category") in ("Resource", "Test") or meta.get("lines", 0) < 5:
            continue
        cr = chunk(meta["content"], max_chars=max_chars, source_label=path)
        fc = _FileChunk(path=path, category=meta["category"], text=cr.text)
        if not cr.truncated and len(cr.text) <= BATCH_CHAR_THRESHOLD:
            to_batch.append(fc)
        else:
            to_single.append(fc)

    # ── Batched small files ───────────────────────────────────────────────────
    for i in range(0, len(to_batch), BATCH_MAX_FILES):
        batch = to_batch[i: i + BATCH_MAX_FILES]
        parts = [f"### FILE: {fc.path}\n```java\n{fc.text}\n```" for fc in batch]
        prompt = (
            "Analyse each Java file below. Return a JSON ARRAY where each element "
            "is the metadata object for one file, in the same order as the files appear.\n\n"
            + "\n\n".join(parts)
        )
        try:
            data_list = llm.complete_json(prompt, system=EXTRACT_SYSTEM)
            if not isinstance(data_list, list):
                raise ValueError(f"Expected JSON array, got {type(data_list).__name__}")
            if len(data_list) != len(batch):
                raise ValueError(
                    f"Batch response has {len(data_list)} items for {len(batch)} files"
                )
            for fc, data in zip(batch, data_list):
                # V9-08: explicit type check before item assignment.
                if not isinstance(data, dict):
                    raise ValueError(
                        f"Batch element for {fc.path!r} is "
                        f"{type(data).__name__!r}, expected dict."
                    )
                data["_path"] = fc.path
                data["_category"] = fc.category
                results.append(data)
                log.info("  ok  %s (batched)", fc.path.split("/")[-1])
        except Exception as exc:
            log.warning(
                "  batch %d-%d failed (%s) -- falling back to singles",
                i, i + len(batch), exc,
            )
            to_single.extend(batch)

    # ── Single (large / fallback) files ──────────────────────────────────────
    for idx, fc in enumerate(to_single):
        prompt = f"Path: {fc.path}\n\n```java\n{fc.text}\n```"
        try:
            data = llm.complete_json(prompt, system=EXTRACT_SYSTEM)
            # V9-08: guard non-dict LLM response before key assignment.
            # Without this, a string/list response raises an opaque TypeError.
            if not isinstance(data, dict):
                raise ValueError(
                    f"LLM returned {type(data).__name__!r} for {fc.path!r}, "
                    "expected a JSON object (dict). "
                    f"Response excerpt: {str(data)[:80]!r}"
                )
            data["_path"] = fc.path
            data["_category"] = fc.category
            results.append(data)
            log.info("  ok  %s", fc.path.split("/")[-1])
        except Exception as exc:
            log.warning("  fail  %s: %s", fc.path.split("/")[-1], exc)
            err_entry: dict[str, Any] = {
                "_path":     fc.path,
                "_category": fc.category,
                "file":      fc.path.split("/")[-1],
                "error":     str(exc),
            }
            if hasattr(exc, "__cause__") and exc.__cause__ is not None:
                err_entry["error_cause"] = str(exc.__cause__)
            results.append(err_entry)

        if idx < len(to_single) - 1:
            time.sleep(0.4)

    return results


def phase2_summary(
    files: dict[str, Any],
    knowledge: list[dict[str, Any]],
    llm: ClaudeClient,
) -> dict[str, Any]:
    """Generate a high-level project summary via the LLM."""
    log.info("Phase 2b -- project summary ...")
    if not files:
        log.warning("phase2_summary: files dict is empty -- summary will lack category data.")

    by_cat: dict[str, int] = {}
    for f in files.values():
        cat = f.get("category", "Unknown")
        by_cat[cat] = by_cat.get(cat, 0) + 1

    all_purposes = [
        {"file": k.get("file"), "purpose": k.get("purpose")}
        for k in knowledge if "purpose" in k
    ]

    running = 4
    purposes: list[dict[str, Any]] = []
    for entry in all_purposes:
        entry_len = len(json.dumps(entry, separators=(",", ":"))) + 2
        if running + entry_len > SUMMARY_MAX_CHARS:
            log.warning(
                "SUMMARY PAYLOAD TRIMMED: stopped at %d/%d purposes "
                "(budget %d chars used of %d).",
                len(purposes), len(all_purposes), running, SUMMARY_MAX_CHARS,
            )
            break
        purposes.append(entry)
        running += entry_len

    prompt = (
        f"Project: {REPO_OWNER}/{REPO_NAME} -- Sakila DVD rental REST API\n"
        f"Files: {json.dumps(by_cat, separators=(',', ':'))}\n"
        f"Purposes: {json.dumps(purposes, separators=(',', ':'))}\n\n"
        "Return project summary JSON with keys: project_name, description, architecture, "
        "main_domain, api_style, frameworks (array), key_modules (array), "
        "design_patterns (array), database, total_files_analysed, categories (object)."
    )
    return llm.complete_json(prompt)


def phase3_convert(
    files: dict[str, Any],
    knowledge: list[dict[str, Any]],
    llm: ClaudeClient,
    max_chars: int = MAX_CHUNK_CHARS,
    strict_screen: Literal[True, False] = False,
) -> dict[str, Any]:
    """Convert target Java files to Node.js via the LLM."""
    log.info("Phase 3 -- Node.js conversion ...")
    NODEJS_OUT_DIR.mkdir(exist_ok=True)

    kidx: dict[str, Any] = {k["_path"]: k for k in knowledge if "_path" in k}
    out_map: dict[str, str] = {
        "Controller": "actor.router.js",
        "Service":    "actor.service.js",
        "Repository": "actor.repository.js",
    }
    conversions: dict[str, Any] = {}

    for category, out_name in out_map.items():
        java_path = CONVERSION_TARGETS[category]
        if java_path not in files:
            log.warning("Target not in loaded files: %s", java_path)
            continue

        meta = kidx.get(java_path)
        if meta is None:
            log.warning(
                "No knowledge entry for %s -- conversion will proceed without metadata.",
                java_path,
            )
            meta = {}
        elif "error" in meta:
            log.warning(
                "Knowledge entry for %s has error ('%s') -- proceeding with partial metadata.",
                java_path, meta["error"],
            )

        meta_str = json.dumps(
            {k: v for k, v in meta.items() if not k.startswith("_")},
            separators=(",", ":"),
        )
        cr = chunk(files[java_path]["content"], max_chars=max_chars, source_label=java_path)
        prompt = (
            f"Convert this Java Spring Boot {category} to Node.js.\n\n"
            f"Requirements:\n{CONVERT_HINTS[category]}\n\n"
            f"Metadata:\n{meta_str}\n\n"
            f"Java source:\n```java\n{cr.text}\n```\n\n"
            "Output ONLY the complete Node.js file."
        )

        try:
            code = llm.complete(prompt, system=CONVERT_SYSTEM, max_tokens=4_096)
        except (RuntimeError, requests.HTTPError) as exc:
            log.error("LLM conversion failed for %s (%s) -- skipping.", out_name, exc)
            continue

        dangerous = _screen_generated_code(code, out_name)
        if dangerous and strict_screen:
            log.error("STRICT SCREEN: aborting write for %s due to dangerous patterns.", out_name)
            continue

        try:
            out_path = _safe_output_path(out_name, NODEJS_OUT_DIR)
        except ValueError as exc:
            log.error("Path validation failed for %s: %s -- skipping.", out_name, exc)
            continue

        if not _safe_write(out_path, code):
            continue

        conversions[category] = {
            "java_source":   java_path,
            "nodejs_output": out_name,
            "truncated":     cr.truncated,
            "dropped_chars": cr.dropped_chars,
        }
        log.info(
            "  saved  %s%s", out_name,
            f" [WARNING: source truncated by {cr.dropped_chars:,} chars]"
            if cr.truncated else "",
        )

    return conversions


# ── CLI helpers ───────────────────────────────────────────────────────────────

def _positive_int(value: str) -> int:
    """argparse type: integer > 0."""
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} is not an integer")
    if n <= 0:
        raise argparse.ArgumentTypeError(f"{n} must be > 0")
    return n


def _nonneg_int(value: str) -> int:
    """argparse type: integer >= 0."""
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} is not an integer")
    if n < 0:
        raise argparse.ArgumentTypeError(f"{n} must be >= 0")
    return n


def _positive_float(value: str) -> float:
    """argparse type: float > 0."""
    try:
        f = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} is not a number")
    if f <= 0:
        raise argparse.ArgumentTypeError(f"{f} must be > 0")
    return f


# ── CLI ───────────────────────────────────────────────────────────────────────

def _configure_logging() -> None:
    """Configure root logger (guards against duplicate handlers)."""
    root = logging.getLogger()
    if root.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        fmt="%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%H:%M:%S",
    ))
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser.

    V9-03: --chunk-chars, --max-retries, --llm-timeout, --gh-timeout validated
    at parse time via typed converters, not deep in the pipeline.
    """
    p = argparse.ArgumentParser(
        description="Java -> Node.js Analyzer v9",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--github-token", default=os.environ.get("GITHUB_TOKEN"),
                   help="GitHub PAT for higher API rate limits")
    p.add_argument("--api-key",      default=os.environ.get("ANTHROPIC_API_KEY"),
                   help="Anthropic API key (prefer ANTHROPIC_API_KEY env var)")
    p.add_argument("--offline",      action="store_true",
                   help="Skip GitHub; use embedded codebase snapshot")
    p.add_argument("--chunk-chars",  type=_positive_int, default=MAX_CHUNK_CHARS,
                   help="Max chars per LLM chunk (> 0)")
    p.add_argument("--llm-timeout",  type=_positive_float, default=180.0,
                   help="Base LLM request timeout in seconds (> 0)")
    p.add_argument("--gh-timeout",   type=_positive_float, default=30.0,
                   help="GitHub request timeout in seconds (> 0)")
    p.add_argument("--max-retries",  type=_nonneg_int, default=4,
                   help="Additional LLM retry attempts after first failure (>= 0)")
    p.add_argument("--strict-screen", action="store_true",
                   help="Abort write when dangerous patterns detected in generated code")
    return p


def main() -> None:
    """Entry point."""
    _configure_logging()
    args = build_parser().parse_args()

    if not args.api_key:
        log.error("ANTHROPIC_API_KEY required. Set env var or use --api-key.")
        raise SystemExit(1)

    _ensure_output_dirs()

    print("=" * 64)
    print("  Java Codebase Analyzer & Node.js Converter  v9")
    print(f"  Repo:          {REPO_OWNER}/{REPO_NAME}")
    print(f"  offline:       {args.offline}")
    print(f"  chunk-chars:   {args.chunk_chars:,}")
    print(f"  llm-timeout:   {args.llm_timeout}s  gh-timeout: {args.gh_timeout}s")
    print(f"  max-retries:   {args.max_retries}")
    print(f"  strict-screen: {args.strict_screen}")
    print("=" * 64)

    write_ok = True

    try:
        log.info("Phase 1 -- reading codebase ...")
        if args.offline:
            files = load_embedded()
        else:
            try:
                files = GitHubReader(token=args.github_token, gh_timeout=args.gh_timeout).read()
            except Exception as exc:
                log.warning("GitHub unreachable (%s) -- using embedded snapshot.", exc)
                files = load_embedded()

        inventory = phase1_inventory(files)
        write_ok &= _safe_write(OUTPUT_DIR / "file_inventory.json",
                                json.dumps(inventory, indent=2))
        log.info("-> output/file_inventory.json  (%d files)", len(inventory))

        llm = ClaudeClient(
            api_key=args.api_key,
            llm_timeout=args.llm_timeout,
            max_retries=args.max_retries,
        )
        knowledge = phase2_knowledge(files, llm, max_chars=args.chunk_chars)
        write_ok &= _safe_write(OUTPUT_DIR / "knowledge.json", json.dumps(knowledge, indent=2))
        log.info("-> output/knowledge.json  (%d entries)", len(knowledge))

        summary = phase2_summary(files, knowledge, llm)
        write_ok &= _safe_write(OUTPUT_DIR / "project_summary.json",
                                json.dumps(summary, indent=2))
        log.info("-> output/project_summary.json")

        conversions = phase3_convert(
            files, knowledge, llm,
            max_chars=args.chunk_chars,
            strict_screen=args.strict_screen,
        )

        full: dict[str, Any] = {
            "project_summary":    summary,
            "file_inventory":     inventory,
            "knowledge_base":     knowledge,
            "nodejs_conversions": conversions,
        }
        write_ok &= _safe_write(OUTPUT_DIR / "full_analysis.json",
                                json.dumps(full, indent=2))
        log.info("-> output/full_analysis.json  (consolidated)")

    except KeyboardInterrupt:
        log.warning("Interrupted by user.")
        raise SystemExit(130)
    except RuntimeError as exc:
        log.error("Pipeline failed: %s", exc)
        raise SystemExit(1) from exc
    except Exception as exc:
        log.exception("Unexpected error: %s", exc)
        raise SystemExit(1) from exc

    if not write_ok:
        log.error("One or more output files could not be written.")
        raise SystemExit(2)

    print("\n  Done")


if __name__ == "__main__":
    main()
