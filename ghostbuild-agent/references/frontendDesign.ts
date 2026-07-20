export const frontendDesign = `
Frontend design skill reference
Source pattern: frontend-design skill

Use when building or refining web components, pages, apps, dashboards, games, or interactive tools with a visible UI.

Design workflow:
- Identify purpose, audience, platform constraints, framework, delivery format, content types, and tone.
- Pick a clear aesthetic direction and one memorable visual gesture. Avoid generic templates and mixed visual metaphors.
- Define tokens early: fonts, palette, shadows, radii, spacing, and motion curves.
- Build the actual usable experience as the first screen for apps, tools, and games. Do not create a marketing landing page unless the user asks for one.
- Use semantic markup, accessible labels, logical headings, visible focus states, and good contrast.
- Add purposeful motion with reduced-motion support.
- Verify responsive layout on mobile and desktop.

Control patterns:
- Use icons inside buttons for common tools/actions when an icon exists.
- Use toggles/checkboxes for binary settings, sliders/steppers/inputs for numbers, tabs for views, segmented controls for modes, menus for option sets, and swatches for color.
- Keep repeated item cards at 8px border radius or less unless the existing design system says otherwise.
- Do not put cards inside cards or style whole page sections as floating cards.
- Keep text inside buttons, cards, boards, counters, and toolbars from wrapping or overflowing awkwardly.
- Define stable dimensions for boards, grids, icon buttons, counters, and fixed-format UI so hover states or dynamic text cannot shift layout.

Visual guidance:
- Make the interface tailored to the domain. SaaS/CRM/ops tools should be dense, calm, and scannable; games can be more expressive.
- Avoid one-note palettes dominated by a single hue family.
- Avoid decorative gradient orbs, bokeh blobs, and generic AI-looking backgrounds.
- Use real or generated bitmap imagery when a website needs product, place, object, or person visuals.
- For landing-page heroes, make the H1 the brand/product/place/person name or literal offer/category; supporting copy carries the value prop.
`;
