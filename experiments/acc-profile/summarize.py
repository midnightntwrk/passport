"""Combine compiled models and serial proof requests from one run into a CSV."""
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from statistics import mean


def summarize(directory, output):
    with (directory / "models.csv").open() as source:
        models = {(row["variant"], row["circuit"]): row for row in csv.DictReader(source)}

    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["series", "circuit", "variant", "k", "rows", "mean_s",
                     "run_1_s", "run_2_s", "run_3_s"])
    series = ["sweep", "raw", "rotations"]
    if (directory / "profiles.jsonl").exists():
        series.extend(["profiles", "shared-rotation"])
    for name in series:
        samples = defaultdict(list)
        with (directory / f"{name}.jsonl").open() as source:
            for line in source:
                row = json.loads(line)
                key = (row["circuit"], row.get("variant") or "current")
                samples[key].append(row["milliseconds"] / 1000)
        for (circuit, variant), seconds in sorted(samples.items()):
            if len(seconds) not in (2, 3):
                raise ValueError(f"Expected two or three samples for {name}/{variant}/{circuit}")
            model = models[variant, circuit]
            runs = [f"{value:.3f}" for value in seconds]
            if len(runs) == 2:
                runs.append("")
            writer.writerow([name, circuit, variant, model["k"], model["rows"],
                             f"{mean(seconds):.2f}", *runs])


if __name__ == "__main__":
    summarize(Path(sys.argv[1]), sys.stdout)
