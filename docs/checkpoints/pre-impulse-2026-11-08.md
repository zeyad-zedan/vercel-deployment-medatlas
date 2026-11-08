# Checkpoint before Impulse deployment — 8 November 2026

- Git tag: `checkpoint/pre-impulse-2026-11-08`
- Commit: `6378c2238cef426a1ed28d1802c17bf59c25c56c`
- Previous production deployment: `dpl_DTDP8o5CbVotSJD2zmwpC75aCe6P`
- Previous deployment URL: `vercel-deployment-medatlas-8gw17s30y-med-atlas.vercel.app`
- Project: `prj_WpDAToNBU63QEAGKHvuQfdU14R0g`, team `med-atlas`.

To restore the website, redeploy this checkpoint commit using current production environment
variables, or roll back to the previous deployment. Do not reset the database or restore an old
database dump: that could overwrite students' newer work.

The Impulse migration only adds the separate `impulse` schema. Leave that schema and its data in
place if rolling back the application; the older website does not query it. This preserves private
quiz progress for a later fixed release. Existing MedAtlas students, sessions, questions and
bookmarks do not need any database rollback. The Gemini grading pool remains unchanged.

This checkpoint records application code and the prior deployment, not a point-in-time database snapshot.
