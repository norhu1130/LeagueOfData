# `@lol/map-editor`

Geometry and state-machine logic for drawing and editing custom minimap regions.

The editor transitions through idle, drawing, naming, selected, and editing states; rejects invalid polygons; and returns normalized `norm-v1` region definitions that can be bound directly to an AST location condition.

SVG owns interactive shapes and handles. Large result overlays belong on canvas in the web application.
