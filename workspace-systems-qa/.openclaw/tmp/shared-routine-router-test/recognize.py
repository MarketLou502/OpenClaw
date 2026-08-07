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
from hassil.recognize import recognize_all
from hassil.util import merge_dict

SENTENCES_DIR = Path(__file__).parent / "sentences" / "en"

LEADING_YOU_TELL_ME = re.compile(
    r"^(?:can|could|would) you (?:please )?tell me\s+", re.IGNORECASE
)
LEADING_YOU = re.compile(r"^(?:can|could|would) you (?:please )?", re.IGNORECASE)
LEADING_PLEASE = re.compile(r"^please\s+", re.IGNORECASE)
TRAILING_PLEASE = re.compile(r"\s+please$", re.IGNORECASE)
TRAILING_PUNCT = re.compile(r"[.!?]+$")


def clean(text):
    # Mirrors the wrapper-stripping order the previous regex router used:
    # "tell me" carries the actual intent, so it must be peeled off as a
    # unit with any preceding "can/could/would you", before the remaining
    # generic wrappers are stripped. The "can/could/would you" prefix is
    # required here (not optional) — a bare "tell me" with no such prefix
    # must reach the sentence grammar intact, since several intents (e.g.
    # ListLists, ListBoard, ListHabits) list "tell me" as their own trigger
    # verb and would become unreachable if it were stripped first.
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


def _wildcard_word_count(result):
    """Total words captured by wildcard slots in a match."""
    return sum(
        len((entity.text or "").split())
        for entity in result.entities_list
        if entity.is_wildcard
    )


def _tie_break_key(result):
    """Secondary sort key for results that tie on wildcard word count.

    Mirrors the criteria hassil's own recognize_best() uses (its internal
    _get_result_score, reimplemented here against public RecognizeResult/
    MatchEntity fields instead of importing that private helper): fewest
    wildcard slots, then most literal text matched, then least wildcard
    text length, then intent name for full determinism. An earlier version
    of pick_best() left ties to whatever order recognize_all() happened to
    yield results in — which is really just intent/sentence load order, not
    a real criterion, and empirically could pick either of two equally
    plausible captures for the same wildcard word count (e.g. "what's on my
    board list" parsing {list} as "board" vs as "list", since the sentence
    contains both words and either can serve as the anchor). This key makes
    that fallback principled instead of accidental. It doesn't fully resolve
    every case — a sentence like "delete my list Reading list" ties on all
    four criteria too, since "list Reading" and "Reading list" are the same
    length — but that's an irreducible ambiguity in the sentence itself
    (hassil's own recognize_best can't disambiguate it either), and in
    practice such doubled-anchor phrasing fails safely downstream (the
    captured list name matches no real list, so the workflow reports
    "not found" instead of acting on the wrong thing).
    """
    num_wildcards = sum(1 for entity in result.entities_list if entity.is_wildcard)
    wildcard_text_len = sum(
        len(entity.text or "") for entity in result.entities_list if entity.is_wildcard
    )
    return (num_wildcards, -result.text_chunks_matched, wildcard_text_len, result.intent.name)


def pick_best(results):
    # hassil's own recognize_best() breaks ties by "fewest wildcard slots
    # first, most literal text second" — which silently prefers a
    # single-wildcard intent (e.g. DeleteList's bare {list}) over a
    # multi-wildcard intent (e.g. RemoveListItem's {item} + {list}) any time
    # both can parse the same sentence, regardless of which one actually
    # accounts for more of the sentence with real words instead of wildcard
    # text. That misrouted "delete milk from my Books list" (meant as
    # RemoveListItem) to DeleteList, with the wildcard swallowing "milk from
    # my Books" whole. Sorting by total wildcard word count first fixes this:
    # the parse that pins down more of the sentence in literal words (and
    # leaves less to the wildcard's imagination) wins, which is also just a
    # better general heuristic for "more specific match" than wildcard count
    # alone. Ties on word count fall through to _tie_break_key, which mirrors
    # hassil's own scoring instead of leaving it to load order.
    results = list(results)
    if not results:
        return None
    return min(results, key=lambda result: (_wildcard_word_count(result), _tie_break_key(result)))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"intent": None, "slots": {}}))
        return

    text = clean(sys.argv[1])
    if not text:
        print(json.dumps({"intent": None, "slots": {}}))
        return

    intents = load_intents()
    result = pick_best(recognize_all(text, intents))
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
