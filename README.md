# CalendarIQ

TornPDA and browser userscript for Torn calendar events, personal events, and optional Loot Rangers NPC attack reminders.

## Install or update

[Raw userscript](https://raw.githubusercontent.com/swilliams9114-collab/CalendarIQ/main/CalendarIQ.user.js)

Add the raw URL in TornPDA's userscript settings, or open it with a browser userscript manager. Replace an existing CalendarIQ installation instead of running two copies. Updates are maintained in this repository. Automatic update behaviour depends on your userscript manager and its settings.

## Use

Open CalendarIQ from Torn's profile-picture dropdown. The profile dot is visual only and never opens the panel. Personal events support descriptions, TCT/local times, daily/weekly repeats, and reminders. Reminders appear in-page while Torn is open; there are no background push notifications.

Add a Public Only Torn API key in CalendarIQ Settings for official Torn events. Set your calendar time slot for events with personal start times.

To enable NPC schedules: CalendarIQ → Settings → Show Loot Rangers NPC schedule and reminders → Save. This optional feed is off by default. It shows one planned group start and NPC attack order, with reminders 15 and 5 minutes beforehand. Amber indicates an NPC attack within 15 minutes; green indicates the feed reports an attack underway. Other calendar events retain their existing indicator behaviour.

## Data and privacy

- Settings, personal events, dismissed reminders, keys and cached schedules stay in Torn local storage on the device. Keep the same Torn hostname to access the same storage.
- Official calendar requests go to api.torn.com with the saved Torn key, normally every six hours.
- Optional NPC requests go to api.lzpt.io without Torn keys or personal events, normally every 5–6 minutes while Torn is visible. The service receives normal connection metadata including your IP address.
- Stale NPC schedules remain visible, with NPC alerts paused after ten minutes. Failed requests preserve the last good schedule. Rate-limit responses delay retries.
- Script activity is limited to reading schedules and displaying reminders. No automated attacks, purchases, messages, or other gameplay actions.
- GitHub hosts the script and its updates. Shared faction-calendar integration is not included.

NPC schedule data is supplied by Loot Rangers (LZPT). Community plans may change; the displayed group time is not a guaranteed individual NPC attack time.

Version: 0.3.0. License: MIT (see userscript metadata).
