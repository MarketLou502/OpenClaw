#!/usr/bin/env python3
"""Match a transcript against sentences/en/*.yaml and print {intent, slots} as JSON.

Invoked once per request by shared-routine-router/index.js, mirroring the
existing pattern of spawning a subprocess per workflow call.
"""
import json
import re
import sys
from pathlib import Path

import yaml

from hassil.intents import Intents
from hassil.recognize import recognize_best
from hassil.util import merge_dict

SENTENCES_DIR = Path(__file__).parent / "sentences" / "en"

LEADING_YOU_TELL_ME = re.compile(
    r"^(?:(?:can|could|would) you (?:please )?)?tell me\s+", re.IGNORECASE
)
LEADING_YOU = re.compile(r"^(?:can|could|would) you (?:please )?", re.IGNORECASE)
LEADING_PLEASE = re.compile(r"^please\s+", re.IGNORECASE)
TRAILING_PLEASE = re.compile(r"\s+please$", re.IGNORECASE)
TRAILING_PUNCT = re.compile(r"[.!?]+$")


def clean(text):
    # Mirrors the wrapper-stripping order the previous regex router used:
    # "tell me" carries the actual intent, so it must be peeled off as a
    # unit with any preceding "can/could/would you", before the remaining
    # generic wrappers are stripped.
    value = TRAILING_PUNCT.sub("", text.strip()).strip()
    value = LEADING_YOU_TELL_ME.sub("", value).strip()
    value = LEADING_YOU.sub("", value).strip()
    value = LEADING_PLEASE.sub("", value).strip()
    value = TRAILING_PLEASE.sub("", value).strip()
    return value


def load_intents():
    merged = {"intents": {}}
    for yaml_path in sorted(SENTENCES_DIR.glob("*.yaml")):
        with open(yaml_path, "r", encoding="utf-8") as f:
            merge_dict(merged, yaml.safe_load(f))
    return Intents.from_dict(merged)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"intent": None, "slots": {}}))
        return

    text = clean(sys.argv[1])
    if not text:
        print(json.dumps({"intent": None, "slots": {}}))
        return

    intents = load_intents()
    result = recognize_best(text, intents)
    if result is None:
        print(json.dumps({"intent": None, "slots": {}}))
        return

    slots = {entity.name: entity.value for entity in result.entities_list}
    print(json.dumps({"intent": result.intent.name, "slots": slots}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - always emit valid JSON for the caller
        print(json.dumps({"intent": None, "slots": {}, "error": str(exc)}))
