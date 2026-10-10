# Brake Test Recorder

Phone web app for HV brake testing. Pick the machine, tick the brake test, photograph the two
BrakeTesta slips, and it reads test number, speed, slope, capability, reaction time and
performance. It checks each pair against the site criteria and fills the
WHC-QLD-FRM Mandatory Brake Test Record Sheet, ready to share or save.

Slip reading happens on the phone (Tesseract.js). No account, no API key, and photos never leave the phone.

## Checks on each pair of slips

| Check | Result |
|---|---|
| Test numbers consecutive, not used in another test | Must pass |
| Slope 0 on both slips | Must pass |
| Speed and capability within 5% of each other | Pass. 5–10% asks you to accept a warning. Over 10% stays off the form |
| Capability at or above the machine's minimum | Must pass |
| Response time at or below the machine's maximum | Must pass |
| Test speed inside the rated range on the criteria sheet | Warning |

Only tests that pass (or have an accepted warning) go on the form. Brake performance goes in
Comments as `#4034 = 25 %g`. Machines with no secondary test get N/A ticked.

## Put it online with GitHub Pages (free)

1. On github.com, create a new **public** repository, for example `brake-tests`.
2. **Add file → Upload files**, select every file in this folder, then **Commit changes**.
3. **Settings → Pages**, set Branch to `main` and folder `/ (root)`, then **Save**.
4. After a minute the link shows at the top of that page, like `https://yourname.github.io/brake-tests/`.
   Share that link with the crew.

`form.pdf` is the blank record sheet, so everyone has it ready. GitHub Pages sites are public, so
delete `form.pdf` before uploading if you'd rather not publish the company form. Each phone then
loads its own copy once under Settings → Record sheet PDF (a filled-in copy works too).

## First time on each phone

1. Open the link and tap **Settings**. Enter tester name, cert # and competency number.
   Check the test equipment and calibration dates.
2. Under **Offline use**, tap **Download it now** while you have signal (about 15 MB).
3. Add the page to the home screen (Share → Add to Home Screen on iPhone, ⋮ → Add to Home screen on Android).

## Updating the limits

The machine limits are in `core.js`, in the `MACHINE_TABLE` near the top (from
WHC-BWM-SPC Brake Testing Performance Criteria, issue 3.1, 18 March 2026). Edit the numbers,
update `CRITERIA` with the new issue and date, and upload the file. Phones pick up the change the
next time they open the app with signal.

If the record sheet layout changes, the field positions are in `LAYOUT` in `core.js`.

## Files

- `index.html` app screens
- `core.js` limits, slip reading, checks, form filling
- `sw.js`, `manifest.webmanifest`, `icon*` offline use and home screen icon
- `ocr-worker.js` loads the slip reader
- `pdf-lib.min.js` PDF library (MIT licence in `pdf-lib-LICENSE.md`)
- `form.pdf` blank record sheet (optional, see above)
