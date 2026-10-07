# Reaction Lab

A browser experiment implementing the system for CS 4065/6065 Assignment 1. It measures completion time and errors as the number of target choices increases.

## Run
Hosted using Github Pages, no need to run locally.

1. Turn on sound and use a mouse or trackpad.
2. Enter a numeric participant number (1–6 digits, for example 01). Leading zeros are retained in the CSV text; import the participant column as text in Excel if you want to preserve them there.
3. Click the central Start button. Click the highlighted target as quickly and accurately as possible. If you miss, continue until you hit it.
4. Return to Start for each new trial. After 20 successful trials, rest and click Continue for the next block.
5. Complete all three blocks. With Supabase configured, wait for the database status to confirm that all queued results are saved. Download CSV as a backup; copying and an on-page text view are also available.
6. Export before choosing New participant. Use a distinct participant number for each person.

The window must fit a target area of at least 410 × 410 CSS pixels. The app pauses when the window changes size, loses focus, or becomes hidden. An interrupted active trial is discarded and repeated at the same trial number; completed trials are retained. Keep interruptions rare and note them in your study log.

Pending uploads are backed up separately for each trial, so multiple tabs cannot overwrite each other’s upload queues. Upload requests made during an existing upload are processed afterward, at a safe point outside a trial block. Older queued backups are migrated automatically. If an upload fails, records remain queued for Retry or the next block break.
