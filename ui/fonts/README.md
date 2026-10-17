# UI fonts

Embedded in the Rive file. Both are under the SIL Open Font License 1.1 (the `OFL-*.txt` files here)
and neither declares a Reserved Font Name, so the trimmed copies below may keep their names.

| File | Font | From |
| --- | --- | --- |
| `BarlowCondensed-ExtraBoldItalic.ttf` | Barlow Condensed ExtraBold Italic | npm `@expo-google-fonts/barlow-condensed` 0.4.1 |
| `BarlowCondensed-SemiBold.ttf` | Barlow Condensed SemiBold | npm `@expo-google-fonts/barlow-condensed` 0.4.1 |
| `Inter-Medium.ttf` | Inter Medium | npm `@expo-google-fonts/inter` 0.4.2 |

Each is trimmed to Latin, common punctuation and arrows, which keeps the built `.riv` small:

```bash
pyftsubset <original.ttf> --output-file=<name>.ttf \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212" \
  --layout-features='kern,liga,calt,tnum,lnum' --name-IDs='*' --name-legacy --name-languages='*'
```

Text outside those ranges renders as nothing; add the range and rebuild if the UI ever needs it.
