# Fonts

Used by the invoice PDF (`src/core/billing/invoice-pdf.ts`) — Noto Sans has the ₹ sign.

| File                   | Source                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `NotoSans-Regular.ttf` | https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf  |
| `NotoSans-Bold.ttf`    | https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf     |
| `OFL.txt`              | https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt — SIL Open Font License 1.1 |

The fonts may be bundled and redistributed under the OFL (licence file kept next to them). Latin text only: pdfkit can't shape Devanagari, so billing details are entered in English letters.
