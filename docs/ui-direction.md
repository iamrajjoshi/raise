# UI direction

Raise is a work surface for one request. It should read like an issue handoff or code review, not a landing page, chat client, or agent console.

## Rules for v0.1

- Use one system sans family throughout. Reserve monospace for IDs, timestamps, and literal URLs.
- Keep the canvas neutral, the work area white, and borders easy to see. Orange identifies Raise; green means accepted, amber means waiting or changes requested, and red means error or deletion.
- Keep the request, replies, screenshots, result, and review in reading order. Attachments use plain thumbnails with filenames.
- Use familiar controls and visible labels. A button names the action it takes, such as `Create request`, `Send reply`, or `Ask for changes`.
- Motion connects state changes: new or replaced panels can fade and move by 2 px over 140–180 ms. Respect reduced-motion preferences.
- Skip gradients, glass panels, glowing borders, fake streaming, dark theme, and decorative agent reasoning in v0.1.

## Product language

Raise is the product name. The objects inside it are requests, threads, replies, results, screenshots, and links. Do not turn the product name into a countable noun.

- Screen titles name the job: `Create a request for your agent` and `Review the result`.
- Status copy says who acts next: `Your turn`, `Waiting for the agent`, `Waiting for the reviewer`, or `Closed`.
- Examples should look like real bug reports. Include a route, breakpoint, or observed behavior when it helps.
- Security copy states what a link permits and when the request disappears. Do not make broad claims such as “private” or “secure.”
- Errors say what failed and what to try next. Do not apologize, blame the user, or expose internal names.
- Keep slogans, version badges, launch copy, and “how it works” strips out of task screens.

## Component sources

The implementation uses original code. These sources inform component behavior and review criteria:

- [shadcn/ui](https://ui.shadcn.com/) for accessible field, button, badge, attachment, dialog, and status-marker conventions. It is the component foundation if copied primitives are added later.
- [Beautiful UI](https://www.beautifului.dev/) for approval cards, task rows, and context cards.
- [beUI](https://beui.dev/) for clear upload feedback and buttons that replace busy text with a completed state.
- [Rare UI](https://www.rareui.com/) as a reference catalog. No Rare UI component or visual motif ships in v0.1.
- [transitions.dev](https://transitions.dev/) for state-swap and panel-continuity ideas. No transition snippet is copied because its component license differs from its tooling license.
- [21st.dev](https://21st.dev/) for finding source-available React interaction patterns. Its marketing blocks, shaders, and animated heroes are not a fit for the core work surface.
- [Mobbin](https://mobbin.com/) for studying complete, real product flows and interface copy. It is a research source, not a code dependency.
- [Magic UI](https://magicui.design/) only as a motion reference. Its stated focus is animated components and landing pages, so v0.1 does not use it for visual decoration.

Check the current license and add a notice before copying third-party source. Raise rewrites product ideas as small CSS and React components.

## Main surfaces

`/new` starts with `What needs fixing?` An affected page and screenshots are optional. After creation, the person stays in the reviewer session and sees the agent link once.

`/r/:id` begins with the viewer role, exact deletion time, and current responsibility. Entries read as request activity, not speech bubbles. The result gets more weight than an ordinary reply; `Accept result` and `Ask for changes` sit directly below it.

External URLs use separate `Copy page URL` and `Open page` actions. Open uses a new tab with `noopener noreferrer`; Raise does not fetch or unfurl the page.
