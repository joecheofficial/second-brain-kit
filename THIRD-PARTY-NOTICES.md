# Third-party notices

`kit/map/depth.js` (the 3D view) bundles @babylonjs/core 9.29.0, Apache-2.0,
and the label placement from @mnstry/atelier.

`kit/map/viewer.js` bundles these packages (versions and licences recorded in
`kit/map/viewer.provenance.json`; their licence comments are kept at the end of
the file):

- @mnstry/atelier 0.2.0-alpha.16, Apache-2.0, see `LICENSE` and `NOTICE`
- sigma 3.0.2, MIT
- graphology 0.25.4, MIT
- graphology-layout-forceatlas2 0.10.1, MIT
- graphology-utils 2.5.2, MIT
- events 3.3.0, MIT

The kit's own code and text are released under Apache-2.0 (`LICENSE`).
`setup` installs `@mnstry/atelier` 0.2.0-alpha.23 from npm at the exact version pinned in the brain's `package.json`.
The vendored viewer remains from 0.2.0-alpha.16, as recorded in its provenance.
