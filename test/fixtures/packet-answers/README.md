# Real packet answers that failed on formatting

Raw answers from real `claude -p` calls (Claude Code 2.1.302, subscription, no API key) to
Weaver 0.3.0 (d1cadbc) style-lens REVIEW packets for the Salt Road practice book, captured
2026-10-17. Salt Road is PickBits-owned synthetic text written for testing Weaver.

Every answer failed the 0.3.0 validator with `invalid lens verdict; lens verdict line does not
match JSON verdict`, although every finding in it was valid. The JSON `verdict` carries the
lens label (`"STYLE: CONSISTENT"` instead of `"CONSISTENT"`), and one verdict line has
markdown emphasis.

| File | Packet | Shape |
| --- | --- | --- |
| `ch3-style-label-in-json.answer.txt` | 3:style, first answer | plain verdict line, prose, label in the JSON verdict |
| `ch5-style-label-in-json-trailing-note.answer.txt` | 5:style, first answer | same, plus a note after the JSON block |
| `ch6-style-bold-line-label-in-json.answer.txt` | 6:style, first answer | `**STYLE: CONSISTENT**` verdict line, label in the JSON verdict |
| `ch4-style-after-repair-label-in-json.answer.txt` | 4:style, answer to the repair round | the repair message did not name the allowed words, so the label stayed |

`paragraphs.json` holds the reader-text paragraphs these answers quote, exactly as Weaver's
`reviewParagraphs` produced them for the practice book.
