#!/usr/bin/env python3
"""Keep the latest seven UTC days plus four UTC weeks, capped at 30 days.

Only our timestamped backup objects are eligible; other bucket objects are untouched.
"""
import datetime as dt
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse


def retained(stamps, now):
    dates = sorted(set(stamps), reverse=True)
    days, weeks, keep = set(), set(), set()
    for stamp in dates:
        date = dt.datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        if now - date > dt.timedelta(days=30):
            continue
        day, week = date.date(), date.isocalendar()[:2]
        daily = day not in days and len(days) < 7
        weekly = week not in weeks and len(weeks) < 4
        if daily or weekly:
            keep.add(stamp)
        days.add(day)
        weeks.add(week)
    return keep


def main(target):
    pattern = re.compile(r'cav-(\d{8}T\d{6}Z)-(mongo\.archive\.gz|uploads\.tar\.gz|counts\.json)\.age$')
    if target.startswith('s3://'):
        url = urllib.parse.urlsplit(target)
        prefix = url.path.lstrip('/').rstrip('/') + '/'
        listing = json.loads(subprocess.check_output(['aws', 's3api', 'list-objects-v2', '--bucket', url.netloc, '--prefix', prefix]))
        names = [o['Key'][len(prefix):] for o in listing.get('Contents', [])]
        def remove(name):
            subprocess.run(['aws', 's3', 'rm', '--only-show-errors', target.rstrip('/') + '/' + name], check=True)
    else:
        folder = pathlib.Path(target)
        names = [p.name for p in folder.iterdir() if p.is_file()]
        def remove(name):
            (folder / name).unlink()
    managed = {name: pattern.fullmatch(name).group(1) for name in names if pattern.fullmatch(name)}
    now = dt.datetime.now(dt.timezone.utc)
    groups = {}
    for name, stamp in managed.items():
        groups.setdefault(stamp, set()).add(pattern.fullmatch(name).group(2))
    complete = {stamp for stamp, kinds in groups.items() if len(kinds) == 3}
    keep = retained(complete, now)
    # An interrupted upload cannot displace the last complete daily snapshot.
    for stamp in groups.keys() - complete:
        date = dt.datetime.strptime(stamp, '%Y%m%dT%H%M%SZ').replace(tzinfo=dt.timezone.utc)
        if now - date < dt.timedelta(days=1):
            keep.add(stamp)
    for name, stamp in managed.items():
        if stamp not in keep:
            remove(name)


if __name__ == '__main__':
    main(sys.argv[1])
