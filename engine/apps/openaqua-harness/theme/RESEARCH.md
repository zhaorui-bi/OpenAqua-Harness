# OpenAqua Desktop visual-research synthesis

## Status

No standalone designer research report was present in the repository or the related session history. The first visual direction—Parisian Art Deco, brass and Song-style editorial typography—was a concept proposal, not validated user research. This document records the replacement rationale and makes the visual decisions testable.

## Audience and task model

OpenAqua is used for long, high-attention environmental-engineering sessions involving source-water data, units, evidence, process trains, constraints, paths, code, tables, and status signals. The interface therefore needs to optimize for:

1. fast scanning and reliable hierarchy;
2. low fatigue during long reading sessions;
3. unambiguous action and status colors;
4. clear Latin, Chinese, numerical and monospace text;
5. visual credibility without imitating a journal page or luxury brand.

Aesthetic preference alone is not sufficient evidence. The chosen direction should be validated with representative water-treatment researchers, engineers, and data-oriented users.

## Comparative pattern synthesis

Across scientific publishing and research software, a useful recurring division is:

- editorial identity may use a serif masthead or display face;
- product navigation, controls and dense content use highly legible sans-serif type;
- neutral canvases carry most of the interface;
- one cool interaction color identifies links, focus and primary actions;
- red/orange/green remain scarce so that warning, error and success states retain meaning;
- ornament is kept away from tables, code, plots and reading surfaces.

This is a pattern observation, not proof that every researcher prefers blue or sans-serif type. It is a safer baseline for a technical workbench and can be tested.

## Decisions

### Color

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Canvas | `#F3FBFA` | `#0D2632` | Long-session reading surface |
| Raised surface | `#FFFFFF` | `#143A49` | Cards, menus and composer |
| Primary text | `#17384A` | `#EAF8F5` | Prose and UI labels |
| Muted text | `#496B78` | `#B0CFCB` | Secondary information |
| Canonical blue | `#2777B8` | `#71BDF0` | Links, focus and selection |
| Action blue | `#246EA8` | `#2A76AA` | Filled primary controls |
| Logo aqua | `#43BCC4` | `#5FD3D1` | Decorative highlights and datum lines |
| Logo teal | `#239F83` | `#58C9A9` | Brand gradients, nodes and selected rails |
| Sidebar | `#E7F7F3` | `#0E3542` | Bright navigation and brand support |

The canonical logo retains its original teal-to-blue droplet and green/blue framework nodes. The revised palette deliberately lifts the light sidebar from near-black to pale mint and shifts dark mode from black navy to illuminated deep aqua. Saturated brand colors remain concentrated in the mark, primary controls and small highlights. Amber remains available only for warnings, while red and green retain semantic error/success roles.

The main tested text pairs meet WCAG 2.2 AA:

- light primary text / canvas: `11.75:1`;
- light muted text / canvas: `5.47:1`;
- light faint text / canvas: `4.55:1`;
- light link / canvas: `4.53:1`;
- white / light action button: `5.43:1`;
- light sidebar text / sidebar: `10.79:1`;
- dark primary text / canvas: `14.36:1`;
- dark faint text / canvas: `6.83:1`;
- dark link / canvas: `7.64:1`;
- white / dark action button: `4.92:1`.

Color must never be the only carrier of status. Icons, text labels or shape changes remain required.

### Typography

| Context | Typeface | Guidance |
| --- | --- | --- |
| UI, controls, navigation | Schibsted Grotesk + Noto Sans SC | 14–16 px, weights 400–650 |
| Assistant and user prose | Schibsted Grotesk + Noto Sans SC | approximately 15 px, line-height 1.6–1.65 |
| Brand wordmark and onboarding hero | Cormorant Garamond + Noto Serif SC | display sizes only, normally 24 px or larger |
| Code, paths and data | JetBrains Mono | preserve upstream sizing and syntax semantics |
| Timestamps and counts | UI/mono with tabular numerals | prevent numerical jitter |

Serif typography is intentionally removed from settings headings, session titles, section labels and Markdown headings. Cormorant Garamond has a display-oriented contrast and small x-height; using it at compact UI sizes weakens recognition. Chinese letter spacing is kept near zero rather than applying Latin display tracking.

### Shape and texture

- Replace the decorative diamond lattice with a very low-contrast 32 px orthogonal grid.
- Use one-pixel datum lines and circular timeline nodes rather than brass diamonds.
- Keep radius and shadows moderate; hierarchy should come mainly from surface and spacing.
- Preserve the supplied OpenAqua droplet-and-framework logo without recoloring; all generated icons and in-product marks derive from that single source.

## Validation plan

Use a randomized light/dark prototype comparison with 8–12 representative users. Include water-treatment researchers, consulting/utility engineers, and a mix of Chinese/English workflows.

Measure:

1. five-second first-impression terms: trustworthy, scientific, premium, distracting;
2. time and errors when locating a session, model setting and primary action;
3. perceived reading comfort after a 10-minute technical transcript task;
4. primary-action discoverability;
5. preference with a required reason, rather than preference alone;
6. color-vision and 125%/150% scaling checks.

Revise only after separating usability failures from subjective brand preference.

## Accessibility reference

- WCAG 2.2, contrast minimum: <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>
- WCAG 2.2, use of color: <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html>
