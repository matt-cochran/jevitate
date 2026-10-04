---
"@jevitate/cli": patch
"jevitate": patch
---

A value read through a `cmd:` secret source is now masked in screenshots and video, not only in text (#360). The run's pixel mask builds its secret list when the run starts, before a one-time code exists, and a short code is below the length the mask learns by itself. The value now joins the mask in every live frame and every later page as soon as it is read, before it is typed. A usability run can also type a `cmd:` field now: its command runner used to be dropped, so the field could never be typed.
