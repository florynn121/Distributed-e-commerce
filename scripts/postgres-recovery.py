"""Back up Compose PostgreSQL and rehearse recovery in an isolated container."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4


def backup(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    archive = open(path, "xb", opener=lambda name, flags: os.open(name, flags, 0o600))
    try:
        with archive:
            subprocess.run(
                ["docker", "compose", "exec", "-T", "postgres", "sh", "-ec",
                 'exec pg_dump --format=custom -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
                stdout=archive, check=True,
            )
    except BaseException:
        path.unlink()
        raise
    print(f"PostgreSQL backup saved to {path}")


def verify(path, order_id):
    with path.open("rb") as archive:
        container = f"commerce-restore-{uuid4().hex}"
        subprocess.run(
            ["docker", "run", "--rm", "--detach", "--network", "none", "--name", container,
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=rehearsal",
             "postgres:15-alpine"],
            stdout=subprocess.DEVNULL, check=True,
        )
        try:
            for _ in range(45):
                # TCP readiness excludes the temporary server used by the image's initializer.
                probe = subprocess.run(
                    ["docker", "exec", container, "pg_isready", "-h", "127.0.0.1", "-d", "rehearsal"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                )
                if probe.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("The isolated PostgreSQL container did not become ready.")

            subprocess.run(
                ["docker", "exec", "-i", container, "pg_restore", "-U", "postgres", "-d", "rehearsal",
                 "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error"],
                stdin=archive, check=True,
            )

            expected_order = "true" if order_id is None else f"EXISTS (SELECT FROM public.orders WHERE id = {order_id})"
            query = f"""
                SELECT (SELECT count(*) FROM public.orders),
                       (SELECT count(*) FROM public.order_outbox),
                       (SELECT count(*) FROM public.flyway_schema_history WHERE success),
                       {expected_order}
            """
            orders, pending, migrations, found = subprocess.check_output(
                ["docker", "exec", container, "psql", "-U", "postgres", "-d", "rehearsal",
                 "-v", "ON_ERROR_STOP=1", "-At", "-c", query], text=True,
            ).strip().split("|")
            if int(migrations) == 0:
                raise RuntimeError("The backup has no successful Flyway migrations.")
            if found != "t":
                raise RuntimeError(f"Order #{order_id} is missing from the backup.")
        finally:
            subprocess.run(["docker", "stop", container], stdout=subprocess.DEVNULL, check=True)

    print(f"Restore verified with {orders} orders, {pending} pending outbox events and {migrations} Flyway records.")
    if order_id is not None:
        print(f"Order #{order_id} was found in the restored database.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup_parser = commands.add_parser("backup", help="Back up the running Compose database.")
    backup_parser.add_argument("archive", type=Path)
    verify_parser = commands.add_parser("verify", help="Restore an archive into a temporary database.")
    verify_parser.add_argument("archive", type=Path)
    verify_parser.add_argument("--order-id", type=int, help="Require this order to exist after restore.")
    args = parser.parse_args()
    try:
        if args.command == "backup":
            backup(args.archive)
        else:
            verify(args.archive, args.order_id)
    except FileExistsError:
        sys.exit(f"Backup already exists. Choose a new file name: {args.archive}")
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        sys.exit(f"PostgreSQL recovery check failed: {error}")


if __name__ == "__main__":
    main()
