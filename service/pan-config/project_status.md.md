

---

## CRITICAL ACCURACY NOTES

**As of 2026-03-31 14:24:**
- Terminal overlay input box: Partially working but has issues (double Enter on images, flashing on resize)
- Chat scrollbar: FIXED — no longer auto-jumping to bottom
- Dashboard context memory: BROKEN — needs investigation into why old issues reappear
- Approval notification spam: NOT YET ADDRESSED
- Phone polling timeout: NOT YET ADDRESSED
- Task list must be re-verified against current conversation before showing to user

DO NOT add new items to this file without confirming they're actually reproducible in current build.

## Current Priorities
1. **Fix copy-paste regression** — terminal input still can't receive Ctrl+V (high impact, broken user workflow)
2. **Fix device status stale data** — showing 'off' when device is active
3. **Implement hard refresh** — Ctrl+Shift+R on dashboard should bust cache + reload
4. **Fix terminal message loss** — messages sent during tool execution not captured
5. Phase 4: Make Incognito write to new `incognito_events` table (scope migration)
6. Forget/Danger Zone deletion features (time-range, keyword, smart delete with preview)
7. Phase 7: Geofencing + zones (sensor enforcement, org-forced toggles greyed-out)
