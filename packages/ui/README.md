# `@lol/ui`

Reserved boundary for shared design tokens, reusable components, and centralized product copy.

The current package exports no production component set. Feature-specific UI remains with its owning package until a stable cross-feature pattern emerges. Moving components here must not introduce domain state or API behavior.

## Color roles

The web application defines the production palette as semantic CSS custom properties in `apps/web/src/index.css`. Components must choose a role instead of embedding a new brand color.

| Role                | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| Canvas and surfaces | Page depth, cards, panels, and overlays                |
| Text and muted text | Primary content and supporting metadata                |
| Primary forest      | Interactive controls, selection, and navigation        |
| Terracotta accent   | Analytical emphasis, section labels, and result values |
| Danger              | Destructive actions and errors only                    |
| Focus               | Keyboard focus indicators only                         |

Light and dark themes keep these meanings while using separate contrast-safe values. Charts use the same forest and terracotta anchors, with ochre and muted plum for additional series. Blue is not a general-purpose accent.
