# Design system

TabFlow uses a compact workspace interface suited to a side panel and a full-page dashboard. The same visual language and interaction model apply at both sizes.

## Foundation

Nuxt UI supplies styled controls and Reka supplies underlying accessible behaviors. Shared adapters in `src/ui` provide buttons, inputs, selection controls, dialogs and scrolling surfaces. Feature views compose those controls rather than introducing a second component system.

Semantic color roles live in `public/theme.css`, with typography and Tailwind mappings in `src/assets/main.css`. Surfaces, borders, text, hover, selection and focus have distinct roles in both themes. Project/category colors identify user content. They do not replace navigation or interaction states.

Layouts use Tailwind utilities and the shared class-merging helper. Composition uses flexbox and gap rather than CSS grid or sibling-margin spacing. The spacing scale follows 4, 8, 12, 16, 24 and 32 pixels. Layout spacing uses gap rather than positive margins. Zero-margin resets and positioned overlays remain supported.

Typography distinguishes page titles, section headings, object labels and supporting metadata. A consistent spacing scale and flex layouts keep alignment predictable. Compactness comes from reducing unnecessary structure before reducing readable content or interaction targets.

## Hierarchy and density

Primary content receives the available width. Titles truncate within a flexible column while icons and actions retain their dimensions. Two-line rows have consistent internal padding in resting, hover, selected and focused states.

Nested tabs use a reserved relationship rail beside the content. Selection controls occupy a separate stable column. Connectors show actual parent relationships and remain clear of checkboxes, labels and disclosure icons. Expansion controls share the favicon area without obscuring the diagram. Secondary actions appear contextually without changing row geometry.

## Interaction states

Pointer hover, keyboard focus, selected options and open submenus remain distinguishable in either theme. Focus is visible without duplicating outlines inside compound controls. Icon-only actions have accessible names and concise tooltips. Menus take priority over informational hover content.

Dragging lifts the recognizable source item. A visible destination and action cue explain whether dropping reorders, nests or moves it. Drag feedback does not obstruct content or pointer targets. Cancellation preserves existing state.

Scroll surfaces reveal hidden content with edge fades, shown only where more content exists. Sticky controls remain legible. Popovers fit the viewport and scroll internally when necessary.

## Responsive composition

Side-panel screens prioritize browsing and primary actions. Secondary detail moves into a dialog, menu or dedicated section. Desktop layouts can show navigation and detail together. Narrow layouts use an explicit return path. Toolbars distribute actions according to available width rather than squeezing labels into unusable columns.

## Feedback and continuity

Background synchronization preserves usable controls, input, selection and scroll position. Loading, empty, failed and completed states have separate meanings. Long-running work shows measured progress and elapsed time, with interruption controls near that work.

Transient notices dismiss without disrupting interaction. Persistent errors remain near the affected action and retain a recovery path. User scrolling takes precedence over automatic conversation following. Motion communicates state changes and respects reduced-motion preferences.

## Visual assets and review

Application icons use Phosphor Bold through a shared icon catalog. Site favicons and the application mark retain their identities. The master mark is `public/icons/mark.svg`. `bun run icons` produces extension sizes and the maskable asset.

Interface changes are reviewed in light and dark themes, at narrow and desktop widths, including long labels, selection, focus, hover and populated hierarchies. Rendered fixtures establish visual behavior. Installed-extension checks establish browser integration.
