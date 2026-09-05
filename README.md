# UIKitForge

**Figma → UIKit Swift + XIB Compiler with live browser preview.**

UIKitForge is an experimental web IDE that reads a Figma node using a user-provided Figma Personal Access Token, converts the design hierarchy into UIKit source files, and lets you edit generated Swift while seeing common UIKit style changes reflected instantly in a browser preview.

## MVP features

- Paste a Figma `design`, `file`, or `proto` URL.
- Supports node-specific URLs using `node-id`.
- User supplies their own Figma Personal Access Token.
- Token is kept in browser session storage by default.
- Optional **Remember on this device** stores the token in local storage.
- Reads Figma hierarchy through the REST API using `X-Figma-Token`.
- Converts Figma nodes into an intermediate UIKit layout tree.
- Generates a main `.swift` + `.xib` pair.
- Detects distinct Figma `INSTANCE` component IDs and generates component `.swift` + `.xib` pairs.
- Generates `IBOutlet` declarations and XIB outlet connections.
- Infers Auto Layout rules from Figma constraints (`LEFT`, `RIGHT`, `LEFT_RIGHT`, `CENTER`, `TOP`, `BOTTOM`, `TOP_BOTTOM`).
- Browser preview for frames, text, fills, radius, borders, shadows, opacity and component boundaries.
- Live Swift preview for common assignments such as:
  - `backgroundColor`
  - `textColor`
  - `layer.cornerRadius`
  - `layer.borderColor`
  - `layer.borderWidth`
  - `alpha`
  - `isHidden`
  - label `text`
  - label `font`
  - label `numberOfLines`
- Optional uploaded reference image overlay.
- Click any preview node to inspect frame, style and inferred constraints.
- Download the selected file or export all generated source as a ZIP.
- Built-in demo so the editor/preview can be tested without a Figma token.

## Figma token

Create a Figma Personal Access Token that can read the target file. UIKitForge expects the token to have the appropriate file-content read permission and sends it only in requests from your browser to Figma.

The token is **not** committed to this repository.

## Run locally

```bash
npm install
npm run dev
```

Then open the Vite URL shown in your terminal.

## Deploy to GitHub Pages

A GitHub Actions workflow is included at `.github/workflows/pages.yml`.

For a new repository, open:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

Then run the workflow or push to `main`.

The Vite base path is configured for:

```text
/UIKitForge/
```

## Current architecture

```text
Figma URL + PAT
      ↓
Figma REST API
      ↓
Figma node JSON
      ↓
UIKitForge compiler
      ↓
Intermediate UIKit layout tree
      ├── Swift generator
      ├── XIB generator
      ├── Auto Layout inference
      └── Browser preview model
      ↓
Web IDE
      ├── Files
      ├── Swift/XIB editor
      ├── Live browser preview
      ├── Inspector
      └── ZIP export
```

## Important MVP limitations

Browser Preview is intentionally a **fast approximation**, not UIKit itself.

The generated XIB XML has not yet been passed through Apple's `ibtool`, and generated Swift has not yet been compiled by Xcode. Because Xcode tooling only runs on macOS, true native validation requires the planned macOS agent.

Other current limitations:

- Figma image fills create `UIImageView` placeholders; image binary export is not implemented yet.
- Complex vectors, masks, blend modes, gradients and advanced effects are not fully translated yet.
- Component Swift files are generated and editable, but isolated component hot-preview is not wired yet; the main generated Swift file is live.
- XIB edits do not currently re-parse into Browser Preview.
- Browser preview does not execute arbitrary Swift. It recognizes a safe/common subset of UIKit style assignments.
- Whole-file Figma URLs compile the first visible top-level node. Node-specific URLs are strongly recommended.

## Next phases

### Phase 1.1

- Figma image endpoint + asset download/export.
- Gradients.
- Better Auto Layout / Figma Auto Layout mapping.
- Isolated component live preview.
- XIB XML → preview re-parser.
- Component dependency graph.
- Reference image pulled automatically from Figma node render.

### Phase 2 — Native macOS validator

A lightweight local macOS agent will receive generated files and run:

```text
ibtool validation
      ↓
xcodebuild
      ↓
iOS Simulator
      ↓
real UIKit snapshot
      ↓
visual diff against Figma
```

The browser can then show both **Instant Preview** and **Native Preview**, with native UIKit as the final source of truth.

## Goal

UIKitForge is intended to become a deterministic **Figma → UIKit compiler**, with AI optional for repair/edge cases rather than required for the core conversion path.
