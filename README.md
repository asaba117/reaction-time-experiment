# Reaction Lab

A browser experiment implementing the system for CS 4065/6065 Assignment 1. It measures completion time and errors as the number of target choices increases.

## Run
Hosted using Github Pages, no need to run locally.

1. Turn on sound and use a mouse or trackpad.
2. Enter a numeric participant number (1–6 digits, for example 01). Leading zeros are retained in the CSV text; import the participant column as text in Excel if you want to preserve them there.
3. Click the central Start button. Click the highlighted target as quickly and accurately as possible. If you miss, continue until you hit it.
4. Return to Start for each new trial. After 20 successful trials, rest and click Continue for the next block.
5. Complete all three blocks, click Download CSV, and send the file to the researcher. Each completed file contains all 60 trials; copying and an on-page text view are also available.
6. Download your CSV before closing the page or choosing New participant. Use a distinct participant number for each person.

Results are backed up in the same browser after each completed trial. If you close the page before downloading, reopen it in the same browser and choose Download previous session CSV to recover the most recent session.

When changing frontend assets, update the shared `v` query parameter on the stylesheet and script URLs in `index.html` so browsers fetch the new files. Keep new scripts compatible with previously cached markup.
