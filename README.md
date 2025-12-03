MAJER UPDATE: I AM AWARE THIS MOD/PLUGIN IN ITS CURRENT RELEASE STATE IS FAILING TO HIRE STAFF AS INTENDED. I AM ATTEMPTING TO FIX IT. IT MAY TAKE SUM TIME SO TILL THEN I PERSONALLY SUGGEST AVOIDING THIS PLUGIN.

The Staff AI Manager is a powerful OpenRCT2 plugin that provides intelligent, automated management of all park staff types. It analyzes your park in real-time, automatically assigns patrol zones, dispatches staff to problem areas, and can even auto-hire staff based on park needs.

This plugin transforms staff management from a tedious manual task into an intelligent automated system that keeps your park clean, rides maintained, guests happy, and vandals at bay - all without constant micromanagement.

🗺️ Intelligent Park Analysis
The plugin continuously analyzes your park to understand its layout and needs:

Analysis Type	Description
Path Mapping	Identifies all footpaths and walkable areas
Ride Locations	Maps all ride positions for mechanic assignment
Queue Detection	Identifies queue lines for targeted cleaning
Entrance Tracking	Locates park entrances for security placement
Litter Hotspots	Real-time tracking of litter accumulation
Vandalism Detection	Monitors for damaged benches and bins
Guest Density	Tracks where guests congregate
Guest Happiness	Monitors overall park satisfaction

🧹 Handyman Management
Feature	Description
Enable/Disable AI	Toggle handyman automation
Auto-Hire	Automatically hire based on guest count ratio
Task Configuration	Enable/disable: Sweeping, Watering, Empty Bins, Mowing
Priority Dispatch	Send nearest handyman to litter hotspots
Min/Max Count	Set staffing limits (default: 2-50)
Target Ratio	1 handyman per 100 guests (configurable)
Handyman Orders:

✅ Sweeping (litter cleanup)
✅ Watering (garden maintenance)
✅ Empty Bins (trash collection)
⬜ Mowing (grass cutting - optional)

🔧 Mechanic Management
Feature	Description
Enable/Disable AI	Toggle mechanic automation
Auto-Hire	Hire based on ride count ratio
Preventive Maintenance	Proactively inspect rides with high downtime
Inspection Priority	Prioritize rides needing inspection
Breakdown Response	Dispatch to broken rides immediately
Patrol Zone Generation	Auto-assign zones covering assigned rides
Min/Max Count	Set staffing limits (default: 1-30)
Target Ratio	1 mechanic per 10 rides (configurable)

👮 Security Guard Management
Feature	Description
Enable/Disable AI	Toggle security automation
Auto-Hire	Hire based on guest count
Hotspot Patrol	Position guards at high-traffic areas
Vandalism Response	Dispatch to areas with damaged property
Entrance Coverage	Ensure entrances are monitored
Min/Max Count	Set staffing limits (default: 0-20)
Target Ratio	1 guard per 500 guests (configurable)

🎪 Entertainer Management
Feature	Description
Enable/Disable AI	Toggle entertainer automation
Auto-Hire	Hire based on guest count
Happiness Zones	Deploy to areas with unhappy guests
Guest Hotspot Patrol	Position at crowded areas
Variety Support	Random costume assignment on hire
Min/Max Count	Set staffing limits (default: 0-20)
Target Ratio	1 entertainer per 1000 guests (configurable)

🗺️ Automatic Patrol Zone Generation
The plugin intelligently creates patrol zones for all staff:

Staff Type	Zone Strategy
Handymen	Grid-based zones covering entire park with overlap
Mechanics	Zones encompassing assigned ride clusters
Security	Centered on guest hotspots and entrances
Entertainers	Low happiness areas or high-traffic zones
Zone Features:

Configurable zone size (default: 15 tiles)
Configurable overlap (default: 2 tiles)
Auto-regeneration when staff count changes
Manual regeneration button available

📊 Real-Time Statistics
Statistic	Description
Staff Hired	Total staff hired by auto-hire
Orders Changed	Number of order modifications
Patrol Zones Set	Successful zone assignments
Zones Failed	Failed zone assignments
Dispatches Made	Staff sent to specific locations
Frame Time	Current processing time (ms)
Avg Frame Time	Rolling average processing time
Auto Re-analyze	Park re-analysis count
Auto Gen Zones	Zone regeneration count

🖥️ User Interface
6 Tabbed Sections:

Overview - System status, staff counts, global controls
Handymen - Handyman-specific settings and hire button
Mechanics - Mechanic-specific settings and hire button
Security - Security guard settings and hire button
Entertainers - Entertainer settings and hire button
Stats - Detailed statistics and performance metrics
Global Controls:

✅ Enable AI Manager
✅ Debug Mode
✅ Auto-Hire Staff (syncs to all staff types)
✅ Auto Patrol Zones
✅ Auto Re-analyze
✅ Auto Gen Zones
🔘 Re-analyze Park (manual)
🔘 Reset Statistics

🔘 Generate Zones (manual)
