"""Command-line interface for the `lod-data` package."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


DEFAULT_SILVER = _repo_root() / "data" / "silver"


def _riot_api_key() -> str | None:
    # A gitignored project .env lets local operators provide a key without shell history or CLI
    # arguments. Existing environment variables retain precedence.
    load_dotenv(_repo_root() / ".env", override=False)
    value = os.environ.get("RIOT_API_KEY")
    return value.strip() if value and value.strip() else None


def cmd_synth(args: argparse.Namespace) -> int:
    from .synth.params import SynthParams
    from .synth.writer import write_dataset

    root = Path(args.out)
    params = SynthParams.load()
    if not params.calibration:
        print(
            "Warning: params.json has no calibration record. "
            "Run `lod-data calibrate` first to align metrics with their targets.",
            file=sys.stderr,
        )
    start = time.time()
    print(f"Generating {args.n:,} matches → {root}")
    manifest = write_dataset(
        args.n,
        root,
        seed=args.seed,
        params=params,
        patch=args.patch,
        queue=args.queue,
        region_code=args.region,
        workers=args.workers,
        chunk_size=args.chunk_size,
    )
    elapsed = time.time() - start
    print(f"\nComplete: {elapsed:.1f}s ({args.n / elapsed:,.0f} matches/s)")
    print(f"snapshot_id: {manifest['snapshot_id']}")
    for table, agg in sorted(manifest["tables"].items()):
        print(
            f"  {table:32s} {agg['rows']:>12,} rows  {agg['bytes'] / 1e6:8.1f}MB  "
            f"{agg['files']} files"
        )
    return 0


def cmd_calibrate(args: argparse.Namespace) -> int:
    from .synth.calibrate import calibrate, check

    print(f"Starting calibration (n={args.n:,}, rounds={args.rounds})")
    params, metrics = calibrate(n=args.n, rounds=args.rounds, seed=args.seed)
    failures = check(metrics)
    print("\nAchieved:")
    for k, v in sorted(metrics.items()):
        if not k.startswith("_") and k != "n":
            print(f"  {k:42s} {v:.4f}")
    if failures:
        print("\nTargets outside tolerance:")
        for f in failures:
            print(f"  ✗ {f}")
    if args.write:
        params.save()
        status = "warning: some targets are outside tolerance" if failures else "all targets met"
        print(f"\nSaved params.json ({status})")
    else:
        print("\n(Pass --write to save params.json.)")
    return 1 if failures and args.strict else 0


def cmd_validate(args: argparse.Namespace) -> int:
    from .synth.validate import as_dict, format_result, validate

    root = Path(args.data)
    if not root.exists():
        print(f"Dataset does not exist: {root}", file=sys.stderr)
        return 2
    result = validate(root)
    if args.json:
        print(json.dumps(as_dict(result), indent=2, ensure_ascii=False))
    else:
        print(format_result(result))
    return 0 if result.ok else 1


def cmd_info(args: argparse.Namespace) -> int:
    from .layout import files_per_partition, read_manifest

    root = Path(args.data)
    manifest = read_manifest(root)
    if manifest is None:
        print(f"Manifest does not exist: {root}", file=sys.stderr)
        return 2
    print(f"snapshot_id: {manifest['snapshot_id']}")
    print(f"generated_at: {manifest['generated_at']}")
    print(f"partition keys: {', '.join(manifest['partition_keys'])}")
    print("\nTables:")
    for table, agg in sorted(manifest["tables"].items()):
        counts = files_per_partition(root, table)
        worst = max(counts.values(), default=0)
        warn = "  ← more than 4 files per partition; compaction required" if worst > 4 else ""
        print(f"  {table:32s} {agg['rows']:>12,} rows  {agg['bytes'] / 1e6:8.1f}MB{warn}")
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    from .riot import RiotApiClient, RiotCollector

    api_key = _riot_api_key()
    if not api_key:
        print("RIOT_API_KEY is required.", file=sys.stderr)
        return 2
    match_ids: list[str] = []
    if args.match_ids:
        match_ids.extend(item.strip() for item in args.match_ids.split(",") if item.strip())
    with RiotApiClient(api_key, routing=args.routing) as client:
        if args.puuid:
            match_ids.extend(client.match_ids(args.puuid, start=args.start, count=args.count))
        if not match_ids:
            print("Either --match-ids or --puuid is required.", file=sys.stderr)
            return 2
        result = RiotCollector(client, Path(args.data)).collect(
            match_ids, exclude_surrenders=not args.include_surrenders
        )
    print(
        f"Collection complete {result['completed']:,} · skipped {result['skipped']:,} · "
        f"excluded {result['excluded']:,} · failed {result['failed']:,}"
    )
    return 1 if result["failed"] else 0


def cmd_crawl(args: argparse.Namespace) -> int:
    from .riot import RiotApiClient, RiotApiError, RiotCrawler

    def progress(message: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)

    api_key = _riot_api_key()
    if not api_key:
        print("RIOT_API_KEY is required.", file=sys.stderr)
        return 2
    queue_ids = tuple(dict.fromkeys(args.queue))
    data_dir = Path(args.data)
    with RiotApiClient(
        api_key,
        routing=args.routing,
        platform=args.platform,
        on_wait=lambda seconds: progress(f"Riot API 호출 제한 대기 · {seconds:.1f}초"),
        on_rate_limit=progress,
    ) as client:
        seed_puuids: list[str] = []
        for riot_id in args.riot_id:
            if "#" not in riot_id:
                print("--riot-id must use the GameName#TagLine format.", file=sys.stderr)
                return 2
            game_name, tag_line = riot_id.rsplit("#", 1)
            progress(f"Riot ID 확인 · {riot_id}")
            try:
                account = client.account_by_riot_id(game_name, tag_line)
            except RiotApiError as exc:
                print(
                    f"Riot ID를 찾지 못했습니다: {riot_id} ({exc.status_code})",
                    file=sys.stderr,
                    flush=True,
                )
                return 2
            seed_puuids.append(account["puuid"])
            progress(f"Riot ID 확인 완료 · {riot_id}")
        result = RiotCrawler(client, data_dir).crawl(
            seed_puuids,
            queue_ids=queue_ids,
            matches_per_player=args.matches_per_player,
            max_players=args.max_players,
            max_matches=args.max_matches,
            max_depth=args.max_depth,
            exclude_surrenders=not args.include_surrenders,
            fetch_tiers=not args.skip_tiers,
            progress=progress,
        )
    print(
        f"Crawl complete · players {result.players_visited:,}/"
        f"{result.players_discovered:,} · matches {result.matches_completed:,} · "
        f"skipped {result.matches_skipped:,} · excluded {result.matches_excluded:,} · "
        f"failed {result.matches_failed:,}",
        flush=True,
    )
    if args.normalize:
        from .riot.writer import normalize_bronze

        manifest = normalize_bronze(
            data_dir,
            silver_dir=Path(args.out),
            queue_ids=set(queue_ids),
        )
        print(
            f"Normalization complete {manifest.get('n_matches', 0):,} matches · "
            f"{manifest['snapshot_id']}"
        )
    return 1 if result.matches_failed else 0


def cmd_normalize_riot(args: argparse.Namespace) -> int:
    from .riot.writer import NormalizationProgress, normalize_bronze

    interactive = sys.stderr.isatty()
    last_update = -float("inf")
    inline_progress = False

    def format_duration(seconds: float) -> str:
        seconds = max(0, int(seconds))
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        if hours:
            return f"{hours}h {minutes:02d}m"
        if minutes:
            return f"{minutes}m {seconds:02d}s"
        return f"{seconds}s"

    def show_progress(state: NormalizationProgress) -> None:
        nonlocal inline_progress, last_update
        if (
            not interactive
            and state.processed not in {0, state.total}
            and state.elapsed_seconds - last_update < 5
        ):
            return
        last_update = state.elapsed_seconds
        fraction = state.processed / state.total if state.total else 1.0
        filled = min(24, int(fraction * 24))
        bar = "=" * filled + ">" + "." * max(0, 23 - filled) if filled < 24 else "=" * 24
        rate = state.processed / state.elapsed_seconds if state.elapsed_seconds > 0 else 0.0
        remaining = (state.total - state.processed) / rate if rate > 0 else 0.0
        eta = format_duration(remaining) if rate > 0 else "--"
        message = (
            f"[{bar}] {state.processed:,}/{state.total:,} ({fraction:6.2%}) · "
            f"ok {state.completed:,} · failed {state.failed:,} · excluded {state.excluded:,} · "
            f"{rate:,.1f} matches/s · ETA {eta} · {state.workers} workers"
        )
        if interactive:
            print(f"\r{message}\033[K", end="", file=sys.stderr, flush=True)
            inline_progress = True
        else:
            print(message, file=sys.stderr, flush=True)

    started = time.monotonic()
    manifest = normalize_bronze(
        Path(args.data),
        silver_dir=Path(args.out),
        batch_size=args.batch_size,
        queue_ids=set(args.queue) if args.queue else None,
        workers=args.workers,
        progress=show_progress if args.progress else None,
    )
    if inline_progress:
        print(file=sys.stderr)
    failures = manifest.get("normalizationFailures", [])
    exclusions = manifest.get("normalizationExclusions", [])
    quality = manifest.get("normalizationQuality", {})
    elapsed = time.monotonic() - started
    rate = quality.get("attempted", 0) / elapsed if elapsed > 0 else 0.0
    print(
        f"Normalization complete {manifest.get('n_matches', 0):,} matches · "
        f"failed {quality.get('failed', len(failures)):,} · "
        f"excluded {quality.get('excluded', len(exclusions)):,} · "
        f"{elapsed:.1f}s ({rate:,.1f} matches/s) · {manifest['snapshot_id']}"
    )
    for failure in failures:
        print(f"  {failure['match']}: {failure['error']}", file=sys.stderr)
    for exclusion in exclusions:
        print(
            f"  {exclusion['match']}: excluded ({exclusion['reason']}, "
            f"mapId={exclusion.get('mapId')})",
            file=sys.stderr,
        )
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lod-data", description="LoL match data tools")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("synth", help="Generate synthetic match data")
    p.add_argument("--n", type=int, default=10_000, help="Number of matches to generate")
    p.add_argument("--out", default=str(DEFAULT_SILVER))
    p.add_argument("--seed", type=int, default=20260913)
    p.add_argument("--patch", default="14.19")
    p.add_argument("--queue", default="RANKED_SOLO_5x5")
    p.add_argument("--region", default="SYNTH")
    p.add_argument("--workers", type=int, default=None)
    p.add_argument("--chunk-size", type=int, default=2500)
    p.set_defaults(func=cmd_synth)

    p = sub.add_parser("calibrate", help="Calibrate synthetic model parameters")
    p.add_argument("--n", type=int, default=20_000)
    p.add_argument("--rounds", type=int, default=4)
    p.add_argument("--seed", type=int, default=20260913)
    p.add_argument("--write", action="store_true", help="Save to params.json")
    p.add_argument("--strict", action="store_true", help="Exit nonzero when a target is missed")
    p.set_defaults(func=cmd_calibrate)

    p = sub.add_parser("validate", help="Validate a generated dataset")
    p.add_argument("--data", default=str(DEFAULT_SILVER))
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("info", help="Summarize a dataset manifest")
    p.add_argument("--data", default=str(DEFAULT_SILVER))
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("collect", help="Collect raw Riot Match-V5 data into bronze storage")
    p.add_argument("--data", default=str(_repo_root() / "data"))
    p.add_argument("--routing", default="asia", choices=["americas", "asia", "europe", "sea"])
    p.add_argument("--match-ids", help="Comma-separated Match-V5 match IDs")
    p.add_argument("--puuid", help="Fetch this player's recent match IDs first")
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--count", type=int, default=100)
    p.add_argument(
        "--include-surrenders",
        action="store_true",
        help="Keep surrender and remake matches (excluded by default)",
    )
    p.set_defaults(func=cmd_collect)

    p = sub.add_parser("crawl", help="Crawl Match-V5 from a Riot ID through participant PUUIDs")
    p.add_argument(
        "--riot-id",
        required=True,
        action="append",
        help="Starting GameName#TagLine; repeat to use multiple seed accounts",
    )
    p.add_argument("--data", default=str(_repo_root() / "data"))
    p.add_argument("--out", default=str(DEFAULT_SILVER))
    p.add_argument("--routing", default="asia", choices=["americas", "asia", "europe", "sea"])
    p.add_argument("--platform", default="kr")
    p.add_argument(
        "--queue",
        type=int,
        action="append",
        default=None,
        help="Queue ID to crawl; repeat the option (default: 420 and 480)",
    )
    p.add_argument("--matches-per-player", type=int, default=20)
    p.add_argument("--max-players", type=int, default=25)
    p.add_argument(
        "--max-matches",
        type=int,
        default=None,
        help="Stop after this many completed matches (default: unlimited)",
    )
    p.add_argument("--max-depth", type=int, default=2)
    p.add_argument("--include-surrenders", action="store_true")
    p.add_argument("--skip-tiers", action="store_true")
    p.add_argument("--normalize", action=argparse.BooleanOptionalAction, default=True)
    p.set_defaults(func=cmd_crawl)

    p = sub.add_parser("normalize-riot", help="Normalize bronze Riot JSON into silver Parquet")
    p.add_argument("--data", default=str(_repo_root() / "data"))
    p.add_argument("--out", default=str(DEFAULT_SILVER))
    p.add_argument(
        "--queue",
        type=int,
        action="append",
        default=None,
        help="Only normalize this queue ID; repeat to include multiple queues",
    )
    p.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Worker processes (default: logical CPUs minus one; use 1 for sequential)",
    )
    p.add_argument("--batch-size", type=int, default=250, help="Matches buffered per write batch")
    p.add_argument(
        "--progress",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Show normalization progress, throughput, and ETA",
    )
    p.set_defaults(func=cmd_normalize_riot)

    args = parser.parse_args(argv)
    if args.command == "crawl" and args.queue is None:
        args.queue = [420, 480]
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
