# UI direction

Raise is a work surface for one request. It should feel like opening a clean sheet, dropping in the mess, and passing that sheet to someone. It is not a landing page, chat box, dashboard, or intake form.

## Rules for v0.1

- Treat the request as the page itself. On desktop, a crisp white sheet sits slightly left of center on a cool blue-gray field. On mobile, the sheet becomes the viewport.
- Use a ruled two-cell masthead instead of a navbar. The left cell holds the mark; the second holds a printed page label or the raised `New request` action.
- Use self-hosted IBM Plex Sans for controls and IBM Plex Serif for request content. Interface copy never drops below 13 px; writing starts at 18 px with generous leading.
- Keep edges square and explicit. The sheet gets one defined border and no shadow. Controls use a 3 px radius; pills only represent real statuses.
- Orange identifies Raise and the primary action. Cobalt marks keyboard focus, green means accepted, amber means waiting or changes requested, and red means failure or expiry.
- Keep the request, replies, screenshots, result, and review in reading order. A thread reads like an editorial log with role and time in the margin, not a rail of chat bubbles.
- Use familiar controls and literal labels: `Add file`, `Send`, `Accept result`, and `Ask for changes`.
- Build every action from the same shallow key: a one-pixel edge, a hard two-pixel bottom edge, and a two-pixel press. IBM Plex Mono is reserved for shortcut caps, IDs, URLs, and control glyphs.
- Motion explains a state change. Attachments and replacement panels can fade in and move 2 px over 180 ms with ease-out; reduced-motion settings remove it.
- Skip hero copy, warm beige surfaces, rounded cards, diffuse shadows, gradients, glass, glowing borders, fake streaming, and decorative agent reasoning.

## Product language

Raise is the product name. The objects inside it are requests, threads, replies, results, screenshots, and links. Do not turn the product name into a countable noun.

- Screen titles name the job: `New request` and `Review the result`.
- Status copy says who acts next: `Your turn`, `Waiting for the agent`, `Waiting for the reviewer`, or `Closed`.
- Examples should look like real bug reports. Include a route, breakpoint, or observed behavior when it helps.
- Security copy states what a link permits and when the request disappears. Do not make broad claims such as “private” or “secure.”
- Errors say what failed and what to try next. Do not apologize, blame the user, or expose internal names.
- Keep slogans, version badges, launch copy, and “how it works” strips out of task screens.

## Component sources

The implementation uses original code. These sources inform component behavior and review criteria:

- [shadcn/ui](https://ui.shadcn.com/) for accessible field, button, badge, attachment, dialog, and status-marker conventions. It is the component foundation if copied primitives are added later.
- [Impeccable](https://impeccable.style/) for the documented `distill → layout → typeset → colorize → polish` review order and its deterministic catalog of generated-UI tells.
- [Beautiful UI](https://www.beautifului.dev/) for approval cards, task rows, and context cards.
- [beUI](https://beui.dev/) for clear upload feedback and buttons that replace busy text with a completed state.
- [Rare UI](https://www.rareui.com/) as a reference catalog. No Rare UI component or visual motif ships in v0.1.
- [transitions.dev](https://transitions.dev/) for state-swap and panel-continuity ideas. No transition snippet is copied because its component license differs from its tooling license.
- [21st.dev](https://21st.dev/) for finding source-available React interaction patterns. Its marketing blocks, shaders, and animated heroes are not a fit for the core work surface.
- [Mobbin](https://mobbin.com/) for studying complete, real product flows and interface copy. It is a research source, not a code dependency.
- [Magic UI](https://magicui.design/) only as a motion reference. Its stated focus is animated components and landing pages, so v0.1 does not use it for visual decoration.

Check the current license and add a notice before copying third-party source. Raise rewrites product ideas as small CSS and React components.

## Main surfaces

`/new` is one full-height dispatch sheet, not a stack of fields or a textarea card. The first non-empty line becomes the thread title. People can paste plain text from Word, Google Docs, email, or a web page without cleaning it up first. They can paste screenshots anywhere in the sheet or drop `.txt`, `.md`, and `.markdown` files; text-file contents become editable text and the original file is not uploaded. Links stay in the notes instead of going through an affected-page field. After creation, the person stays in the reviewer session and sees the agent link once.

Replies and results reuse the same compact scratchpad. Keep screenshot previews, file feedback, the attach control, and the send action inside its border. Screenshots have a 15 MiB combined budget per send instead of a visible count limit. PDF and DOCX files are not accepted as uploads in v0.1; the person can paste the relevant text.

`/r/:id` keeps the same sheet. Viewer role, deletion time, and current responsibility form a compact dateline below the title; there is no dashboard sidebar. Entries read as request activity, not speech bubbles. The result gets a stronger top rule than an ordinary reply, and `Accept result` plus `Ask for changes` sit directly below it.

External URLs use separate `Copy page URL` and `Open page` actions. Open uses a new tab with `noopener noreferrer`; Raise does not fetch or unfurl the page.
