# Frontend Inspiration Sources

Use this registry when `frontend_designer`, `ux_researcher`, or `planner` prepares an autonomous UI redesign or high-polish visual surface.

## Goal

Give autonomous frontend agents a public/free inspiration pack with enough curation, breadth, and structure to derive strong visual directions before implementation, especially when the target surface needs immersive motion, media, or game-like interaction depth.

This registry also records the current workflow evidence that strong agentic UI systems use visual exploration artifacts, not prompt-to-code alone, when the surface is taste-critical.

## Selection criteria

- public and free to browse without requiring a paid plan
- broad enough to support repeated redesign tasks
- curated enough to avoid low-signal sludge
- structured enough for agentic filtering by category, style, platform, technology, or color
- visually rich enough to support typography, motion, composition, and theming decisions
- strong enough to support interaction choreography, imagery strategy, and immersive surfaces rather than static shells only
- broad enough to support both artistic ceiling and control-discoverability examples

## Primary sources

### 1. `Awwwards`

URL: `https://www.awwwards.com/websites/`

Use for:
- ambition ceiling
- motion and interaction references
- experimental composition
- technology-specific inspiration

Why it ships:
- public browse surface exposes categories, tags, technologies, fonts, and colors
- strongest source for countering median dashboard output because it exposes what highly judged web work looks like at the top end
- best first source when the agent needs a signature move, unusual composition, or motion ambition

Best fit:
- when the redesign needs to be memorable, not merely polished
- when the redesign needs a visible interaction hook, dramatic sequencing, or motion-led information reveal

### 2. `Godly`

URL: `https://godly.website/`

Use for:
- taste calibration
- quality-over-quantity reference packs
- stronger curation against generic product design sludge

Why it ships:
- explicitly optimizes for quality rather than volume
- better at helping agents avoid average-looking app UI because the surface is more selective than broad gallery sites
- strongest source for answering "does this feel authored?" before implementation

Best fit:
- when the agent needs fewer but sharper references to keep the output from averaging out
- when the brief needs authored atmosphere without collapsing into noisy gimmicks

### 3. `Siteinspire`

URL: `https://www.siteinspire.com/`

Use for:
- layout direction
- style and subject matching
- balanced brand/editorial/product references

Why it ships:
- explicitly positions itself as a showcase of the web's finest design and talent
- exposes popular `Categories`, `Styles`, `Types`, `Subjects`, and `Platforms`
- strong for quickly building a direction pack around structural qualities like `Minimal`, `Grid Layout`, `Unusual Layout`, or `Use of Animation`

Best fit:
- when the agent needs a controlled but broad stylistic map
- when the agent needs a structural bridge between experimental references and a usable product surface

## Runner-up

URL: `https://www.lapa.ninja/`

Use for:
- landing-page composition
- page density and section rhythm
- color and platform scanning
- full-page screenshot references

Best fit:
- when the agent needs concrete full-page references for marketing, SaaS, AI, or launch surfaces after the core concept is already chosen

## Required usage pattern

For substantive redesign work:

1. collect at least 6 references total
2. use at least 3 different sources
3. include at least 1 ambition reference from `Awwwards`
4. include at least 1 taste-calibration reference from `Godly`
5. include at least 1 structurally relevant reference from `Siteinspire`
6. include at least 1 non-web reference such as poster, editorial, album art, game UI, or packaging
7. include at least 1 game UI, title sequence, or similarly dramatic non-web reference when the brief asks for an impressive or menu-like result
8. include at least 1 motion-led reference whose choreography matters, not just its screenshot
9. include at least 1 imagery, 3D, texture, or media-led reference when the brief asks for immersive results
10. include at least 1 reference that keeps key actions visible despite a high-art presentation
11. record the likely implementation stack for the chosen direction (e.g. `Motion`, `Rive`, `GSAP`, `three.js`, CSS, video, or hybrid media)
12. record the `media-first concept decision` for the chosen direction: what authored medium carries the visual identity beyond layout and color
13. add official implementation guidance to the plan when immersive motion is central:
   - `motion.dev/docs/react` for React motion systems and reduced-motion handling
   - `rive.app/docs/runtimes` for authored interactive motion graphics
   - `gsap.com/docs/v3/Plugins/ScrollTrigger/` for scroll-sequenced motion
   - `threejs.org/manual/en/creating-a-scene.html` when the concept truly needs 3D/WebGL
14. if illustration, mascots, world-building, or playful atmosphere are core to the concept, record whether generated imagery, edited artwork, or sourced assets should be used, and why
15. if 3D depth or camera motion is being considered, record why `three.js` or equivalent is conceptually necessary instead of using it as generic spectacle
16. include `Lapa Ninja` only when full-page landing density or section rhythm is central
17. record why each chosen reference matters
18. name the screen's `signature move` before implementation starts
19. name the `impressiveness hypothesis`, `design-family reset`, `repeated primitive ban`, and `control map` before implementation starts
20. create at least 1 externalized visual exploration artifact for a broad remake before production code starts:
   - lightweight HTML mock
   - SVG storyboard
   - screenshot paintover
   - generated image
   - or equivalent durable visual concept artifact
21. when the user supplies an avatar, illustration, or vibe image, write a `reference translation brief` that extracts:
   - motion personality
   - charm vocabulary
   - material treatment
   - palette energy
   - line softness or sharpness
   - interaction tone
   - what should become reusable UI behavior rather than literal artwork placement
22. when cute, magical, or lively atmosphere is requested, define a `semantic charm map` showing where motifs belong and what job they serve
23. include at least 1 official motion-implementation source when playful or immersive motion is part of the brief, even if CSS remains the final stack
24. broad remakes must explicitly justify using or not using generated imagery, authored interaction art, or 3D depth when those media could materially change the result
25. dashboard, admin, control-center, and game-like surfaces still require the exploration artifact step, even if other tools would normally skip design guidance for those categories
26. if the first critique still reads as the same family reordered, create 1 `opposite-direction artifact` before continuing implementation

## Anti-patterns

- naming inspiration websites without citing actual references
- using a single gallery as the only aesthetic source
- using only trend language instead of concrete references
- copying a reference directly instead of abstracting motifs, hierarchy, and motion tone
- treating a vibe image as a literal UI asset by default instead of translating it into system behavior
- using broad-coverage gallery sites only and never calibrating against a stronger taste ceiling
- using static screenshot references only for a motion-heavy brief
- adding cute details with no state, narrative, section, or interaction reason
- choosing `three.js` or video-heavy treatments by default when `Motion`, `Rive`, or `GSAP` would satisfy the concept more cleanly
- relying on web references only when the desired feeling is closer to a game UI, title card, or filmic interface
- silently defaulting to CSS-only styling when the concept clearly needs authored imagery, world-building, or deeper motion craft
- claiming a new concept family while reusing the same shell or panel primitives in a new order
- using only production-code variants instead of externalized exploration artifacts for a broad remake
