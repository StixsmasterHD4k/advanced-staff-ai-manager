/**
 * Staff AI Manager Plugin for OpenRCT2
 * Version: 3.0.0 - Smart Detection & Event-Based Hiring
 * 
 * NEW FEATURES IN v3.0:
 * - Ride built detection with entrance/exit/path tracking
 * - Crime/vandalism event detection for security hiring
 * - Guest feedback analysis for handyman hiring (disgust, litter complaints)
 * - Guest happiness monitoring for entertainer hiring (<60% threshold)
 * - Enhanced patrol zone generation based on ride coverage
 * 
 * MULTIPLAYER COMPATIBLE - Server-side only (type: 'remote')
 */

(function() {
    'use strict';

    // ============================================================
    // CONFIGURATION
    // ============================================================
    var CONFIG = {
        enabled: true,
        debugMode: false,
        staffUpdateInterval: 60,
        analysisInterval: 180,
        statisticsInterval: 120,
        autoHireCheckInterval: 200,
        patrolZoneUpdateInterval: 600,
        autoReanalyzeInterval: 1200,
        autoGenZonesInterval: 1000,
        eventCheckInterval: 30,
        maxStaffPerTick: 5,
        frameBudgetMs: 2.0,
        
        // Handyman settings
        handymanEnabled: true,
        handymanAutoHire: true,
        handymanTargetRatio: 0.01,
        handymanMinCount: 2,
        handymanMaxCount: 50,
        handymanLitterThreshold: 15,
        handymanDisgustThreshold: 10,
        handymanSweepEnabled: true,
        handymanMowEnabled: false,
        handymanWaterEnabled: true,
        handymanEmptyBinsEnabled: true,
        handymanPriorityDispatch: true,
        
        // Mechanic settings
        mechanicEnabled: true,
        mechanicAutoHire: true,
        mechanicTargetRatio: 0.15,
        mechanicMinCount: 1,
        mechanicMaxCount: 30,
        mechanicPreventiveEnabled: true,
        mechanicInspectionPriority: true,
        mechanicBreakdownRadius: 30,
        mechanicPerNewRide: true,
        
        // Security settings
        securityEnabled: true,
        securityAutoHire: true,
        securityTargetRatio: 0.002,
        securityMinCount: 0,
        securityMaxCount: 20,
        securityHotspotPatrol: true,
        securityVandalismResponse: true,
        securityCrimeThreshold: 3,
        
        // Entertainer settings
        entertainerEnabled: true,
        entertainerAutoHire: true,
        entertainerTargetRatio: 0.001,
        entertainerMinCount: 0,
        entertainerMaxCount: 20,
        entertainerHappinessZones: true,
        entertainerVariety: true,
        entertainerHappinessThreshold: 60,
        
        // Automation settings
        autoHireEnabled: true,
        autoFireEnabled: false,
        autoHireDelay: 600,
        autoPatrolZones: true,
        autoReanalyze: true,
        autoGenZones: true,
        patrolZoneSize: 15,
        patrolZoneOverlap: 2,
        smartHiringEnabled: true,
        
        // Energy management
        energyManagement: true,
        lowEnergyThreshold: 40,
        criticalEnergyThreshold: 25,
        pathfindingIntegration: true
    };

    var HANDYMAN_ORDERS = {
        SWEEPING: 1,
        WATERING: 2,
        EMPTY_BINS: 4,
        MOWING: 8
    };

    var MECHANIC_ORDERS = {
        INSPECT: 1,
        FIX: 2
    };

    // ============================================================
    // DETERMINISTIC RANDOM (Multiplayer Safe)
    // ============================================================
    var DeterministicRandom = {
        getSeed: function() {
            try { return date.ticksElapsed || 0; } catch (e) { return 0; }
        },
        random: function(offset) {
            var seed = this.getSeed() + (offset || 0);
            var x = Math.sin(seed * 12.9898) * 43758.5453;
            return x - Math.floor(x);
        },
        randomInt: function(min, max, offset) {
            return Math.floor(this.random(offset) * (max - min + 1)) + min;
        }
    };

    // ============================================================
    // NETWORK HELPER
    // ============================================================
    var NetworkHelper = {
        getMode: function() {
            try { return network.mode; } catch (e) { return 'none'; }
        },
        isServer: function() {
            var mode = this.getMode();
            return mode === 'none' || mode === 'server';
        },
        canModifyGameState: function() {
            return this.isServer();
        },
        getModeString: function() {
            var mode = this.getMode();
            if (mode === 'none') return 'Single Player';
            if (mode === 'server') return 'Multiplayer (Host)';
            if (mode === 'client') return 'Multiplayer (Client)';
            return 'Unknown';
        }
    };

    // ============================================================
    // PERFORMANCE MONITOR
    // ============================================================
    var PerformanceMonitor = {
        frameStartTime: 0,
        frameTimes: [],
        startFrame: function() { this.frameStartTime = Date.now(); },
        getElapsedMs: function() { return Date.now() - this.frameStartTime; },
        endFrame: function() {
            var elapsed = this.getElapsedMs();
            this.frameTimes.push(elapsed);
            if (this.frameTimes.length > 30) this.frameTimes.shift();
            return elapsed;
        },
        getAverageFrameTime: function() {
            if (this.frameTimes.length === 0) return 0;
            var sum = 0;
            for (var i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
            return sum / this.frameTimes.length;
        }
    };

    // ============================================================
    // SPATIAL HASH
    // ============================================================
    function SpatialHash(cellSize) {
        this.cellSize = cellSize || 16;
        this.cells = {};
    }
    SpatialHash.prototype.getKey = function(x, y) {
        return Math.floor(x / this.cellSize) + ',' + Math.floor(y / this.cellSize);
    };
    SpatialHash.prototype.add = function(x, y, value) {
        var key = this.getKey(x, y);
        if (!this.cells[key]) this.cells[key] = [];
        this.cells[key].push({ x: x, y: y, value: value });
    };
    SpatialHash.prototype.clear = function() { this.cells = {}; };
    SpatialHash.prototype.count = function() {
        var total = 0;
        for (var key in this.cells) {
            if (this.cells.hasOwnProperty(key)) total += this.cells[key].length;
        }
        return total;
    };

    // ============================================================
    // RIDE TRACKER - Detects new rides and their entrances/exits
    // ============================================================
    var RideTracker = {
        knownRides: {},
        rideEntrances: {},
        rideExits: {},
        ridePaths: {},
        newRidesDetected: [],
        lastRideCount: 0,

        initialize: function() {
            this.scanAllRides();
        },

        scanAllRides: function() {
            try {
                var rides = map.rides;
                for (var i = 0; i < rides.length; i++) {
                    var ride = rides[i];
                    if (ride && ride.classification === 'ride') {
                        this.trackRide(ride);
                    }
                }
                this.lastRideCount = rides.length;
            } catch (e) {}
        },

        trackRide: function(ride) {
            if (!ride || this.knownRides[ride.id]) return;
            
            this.knownRides[ride.id] = {
                id: ride.id,
                name: ride.name || 'Unknown Ride',
                type: ride.type,
                trackedAt: this.getGameTick()
            };

            // Find entrance and exit locations
            this.findRideEntrancesExits(ride);
            
            // Mark as newly detected
            this.newRidesDetected.push(ride.id);
            
            if (CONFIG.debugMode) {
                console.log('[Staff AI] New ride detected: ' + (ride.name || 'Ride ' + ride.id));
            }
        },

        findRideEntrancesExits: function(ride) {
            if (!ride || !ride.stations) return;
            
            this.rideEntrances[ride.id] = [];
            this.rideExits[ride.id] = [];
            this.ridePaths[ride.id] = [];

            for (var i = 0; i < ride.stations.length; i++) {
                var station = ride.stations[i];
                if (!station) continue;

                // Station entrance
                if (station.entrance) {
                    this.rideEntrances[ride.id].push({
                        x: station.entrance.x,
                        y: station.entrance.y,
                        z: station.entrance.z || 0
                    });
                    this.findConnectedPaths(station.entrance.x, station.entrance.y, ride.id);
                }

                // Station exit
                if (station.exit) {
                    this.rideExits[ride.id].push({
                        x: station.exit.x,
                        y: station.exit.y,
                        z: station.exit.z || 0
                    });
                    this.findConnectedPaths(station.exit.x, station.exit.y, ride.id);
                }

                // Station start position
                if (station.start) {
                    this.ridePaths[ride.id].push({
                        x: station.start.x,
                        y: station.start.y,
                        type: 'station'
                    });
                }
            }
        },

        findConnectedPaths: function(startX, startY, rideId) {
            // BFS to find connected paths (limited depth)
            var visited = {};
            var queue = [{ x: startX, y: startY, depth: 0 }];
            var maxDepth = 10;
            var directions = [[0, 1], [0, -1], [1, 0], [-1, 0]];

            while (queue.length > 0) {
                var current = queue.shift();
                var key = current.x + ',' + current.y;
                
                if (visited[key] || current.depth > maxDepth) continue;
                visited[key] = true;

                try {
                    var tile = map.getTile(current.x, current.y);
                    if (tile) {
                        for (var i = 0; i < tile.numElements; i++) {
                            var element = tile.getElement(i);
                            if (element && element.type === 'footpath') {
                                this.ridePaths[rideId].push({
                                    x: current.x,
                                    y: current.y,
                                    type: 'path'
                                });

                                // Add neighbors to queue
                                for (var d = 0; d < directions.length; d++) {
                                    queue.push({
                                        x: current.x + directions[d][0],
                                        y: current.y + directions[d][1],
                                        depth: current.depth + 1
                                    });
                                }
                                break;
                            }
                        }
                    }
                } catch (e) {}
            }
        },

        checkForNewRides: function() {
            try {
                var rides = map.rides;
                if (rides.length !== this.lastRideCount) {
                    for (var i = 0; i < rides.length; i++) {
                        var ride = rides[i];
                        if (ride && ride.classification === 'ride' && !this.knownRides[ride.id]) {
                            this.trackRide(ride);
                        }
                    }
                    this.lastRideCount = rides.length;
                    return this.newRidesDetected.length > 0;
                }
            } catch (e) {}
            return false;
        },

        getNewRides: function() {
            var newRides = this.newRidesDetected.slice();
            this.newRidesDetected = [];
            return newRides;
        },

        getRideCoverage: function(rideId) {
            var coverage = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            
            var entrances = this.rideEntrances[rideId] || [];
            var exits = this.rideExits[rideId] || [];
            var paths = this.ridePaths[rideId] || [];
            
            var allPoints = entrances.concat(exits).concat(paths);
            
            for (var i = 0; i < allPoints.length; i++) {
                var p = allPoints[i];
                coverage.minX = Math.min(coverage.minX, p.x);
                coverage.minY = Math.min(coverage.minY, p.y);
                coverage.maxX = Math.max(coverage.maxX, p.x);
                coverage.maxY = Math.max(coverage.maxY, p.y);
            }
            
            // Add padding
            coverage.minX = Math.max(0, coverage.minX - 3);
            coverage.minY = Math.max(0, coverage.minY - 3);
            coverage.maxX += 3;
            coverage.maxY += 3;
            
            return coverage;
        },

        getGameTick: function() {
            try { return date.ticksElapsed || 0; } catch (e) { return 0; }
        }
    };

    // ============================================================
    // CRIME DETECTOR - Monitors vandalism and crime events
    // ============================================================
    var CrimeDetector = {
        vandalismCount: 0,
        recentCrimes: [],
        crimeHotspots: new SpatialHash(16),
        lastCheck: 0,

        update: function() {
            this.vandalismCount = 0;
            this.crimeHotspots.clear();
            this.recentCrimes = [];

            // Check for broken/vandalized path additions (benches, bins, lamps)
            try {
                var mapWidth = map.size.x;
                var mapHeight = map.size.y;
                
                // Sample paths for vandalism
                for (var i = 0; i < ParkAnalyzer.pathTiles.length && i < 300; i++) {
                    var pathTile = ParkAnalyzer.pathTiles[i];
                    try {
                        var tile = map.getTile(pathTile.x, pathTile.y);
                        if (tile) {
                            for (var j = 0; j < tile.numElements; j++) {
                                var element = tile.getElement(j);
                                if (element && element.type === 'footpath') {
                                    // Check for vandalized additions
                                    if (element.isBroken || element.isBlockedByVehicle) {
                                        this.vandalismCount++;
                                        this.crimeHotspots.add(pathTile.x, pathTile.y, { type: 'vandalism' });
                                        this.recentCrimes.push({
                                            x: pathTile.x,
                                            y: pathTile.y,
                                            type: 'vandalism',
                                            tick: this.getGameTick()
                                        });
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        },

        getCrimeLevel: function() {
            return this.vandalismCount;
        },

        needsMoreSecurity: function() {
            return this.vandalismCount >= CONFIG.securityCrimeThreshold;
        },

        getCrimeHotspots: function(maxCount) {
            var hotspots = [];
            for (var key in this.crimeHotspots.cells) {
                if (this.crimeHotspots.cells.hasOwnProperty(key)) {
                    var parts = key.split(',');
                    hotspots.push({
                        x: parseInt(parts[0]) * 16,
                        y: parseInt(parts[1]) * 16,
                        count: this.crimeHotspots.cells[key].length
                    });
                }
            }
            hotspots.sort(function(a, b) { return b.count - a.count; });
            return hotspots.slice(0, maxCount || 5);
        },

        getGameTick: function() {
            try { return date.ticksElapsed || 0; } catch (e) { return 0; }
        }
    };

    // ============================================================
    // GUEST FEEDBACK ANALYZER - Monitors cleanliness and happiness
    // ============================================================
    var GuestFeedbackAnalyzer = {
        disgustCount: 0,
        litterComplaints: 0,
        averageHappiness: 128,
        happinessPercent: 50,
        unhappyGuestCount: 0,
        totalGuests: 0,
        feedbackSummary: {},

        update: function() {
            this.disgustCount = 0;
            this.litterComplaints = 0;
            this.unhappyGuestCount = 0;
            var totalHappiness = 0;
            var happyCount = 0;

            try {
                var guests = map.getAllEntities('guest');
                this.totalGuests = guests.length;

                for (var i = 0; i < guests.length; i++) {
                    var guest = guests[i];
                    if (!guest) continue;

                    // Track happiness
                    if (typeof guest.happiness === 'number') {
                        totalHappiness += guest.happiness;
                        happyCount++;
                        
                        // Check if unhappy (below 60% = 153 on 0-255 scale)
                        if (guest.happiness < 153) {
                            this.unhappyGuestCount++;
                        }
                    }

                    // Check guest thoughts for complaints
                    if (guest.thoughts && guest.thoughts.length > 0) {
                        for (var j = 0; j < guest.thoughts.length; j++) {
                            var thought = guest.thoughts[j];
                            if (thought) {
                                var thoughtType = thought.type;
                                
                                // Disgust/cleanliness complaints
                                if (thoughtType === 'disgusting' || 
                                    thoughtType === 'bad_litter' ||
                                    thoughtType === 'path_disgusting' ||
                                    thoughtType === 'vandalism') {
                                    this.disgustCount++;
                                }
                                
                                // Litter specific
                                if (thoughtType === 'bad_litter' || 
                                    thoughtType === 'litter') {
                                    this.litterComplaints++;
                                }
                            }
                        }
                    }

                    // Check nausea as indicator of needing cleanup
                    if (typeof guest.nausea === 'number' && guest.nausea > 150) {
                        this.disgustCount++;
                    }
                }

                if (happyCount > 0) {
                    this.averageHappiness = totalHappiness / happyCount;
                    this.happinessPercent = Math.round((this.averageHappiness / 255) * 100);
                }

                this.feedbackSummary = {
                    disgust: this.disgustCount,
                    litter: this.litterComplaints,
                    happiness: this.happinessPercent,
                    unhappy: this.unhappyGuestCount,
                    total: this.totalGuests
                };

            } catch (e) {
                if (CONFIG.debugMode) {
                    console.log('[Staff AI] Guest feedback error: ' + e);
                }
            }
        },

        needsMoreHandymen: function() {
            // Hire if disgust complaints or litter complaints exceed threshold
            return this.disgustCount >= CONFIG.handymanDisgustThreshold ||
                   this.litterComplaints >= CONFIG.handymanLitterThreshold ||
                   ParkAnalyzer.totalLitter > CONFIG.handymanLitterThreshold * 2;
        },

        needsMoreEntertainers: function() {
            // Hire if happiness below 60%
            return this.happinessPercent < CONFIG.entertainerHappinessThreshold;
        },

        getUnhappyAreas: function() {
            var areas = [];
            for (var key in ParkAnalyzer.guestDensity.cells) {
                if (!ParkAnalyzer.guestDensity.cells.hasOwnProperty(key)) continue;
                var items = ParkAnalyzer.guestDensity.cells[key];
                if (items && items.length > 2) {
                    var avgHappy = 0;
                    var count = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].value && typeof items[i].value.happiness === 'number') {
                            avgHappy += items[i].value.happiness;
                            count++;
                        }
                    }
                    if (count > 0) {
                        avgHappy = avgHappy / count;
                        if (avgHappy < 153) { // Below 60%
                            var parts = key.split(',');
                            areas.push({
                                x: parseInt(parts[0]) * 16,
                                y: parseInt(parts[1]) * 16,
                                happiness: Math.round((avgHappy / 255) * 100)
                            });
                        }
                    }
                }
            }
            areas.sort(function(a, b) { return a.happiness - b.happiness; });
            return areas;
        }
    };

    // ============================================================
    // PARK ANALYZER
    // ============================================================
    var ParkAnalyzer = {
        litterLocations: new SpatialHash(8),
        vandalismLocations: new SpatialHash(8),
        guestDensity: new SpatialHash(16),
        pathTiles: [],
        rideLocations: [],
        entranceLocations: [],
        queueLocations: [],
        totalPathTiles: 0,
        totalLitter: 0,
        totalVandalism: 0,
        totalRides: 0,
        totalGuests: 0,
        averageGuestHappiness: 0,
        isAnalyzed: false,
        analysisProgress: 0,
        analysisTotal: 0,

        startAnalysis: function() {
            this.litterLocations.clear();
            this.vandalismLocations.clear();
            this.guestDensity.clear();
            this.pathTiles = [];
            this.rideLocations = [];
            this.entranceLocations = [];
            this.queueLocations = [];
            this.totalPathTiles = 0;
            this.totalLitter = 0;
            this.totalVandalism = 0;
            this.isAnalyzed = false;
            this.analysisProgress = 0;
            try {
                this.analysisTotal = map.size.x * map.size.y;
            } catch (e) {
                this.analysisTotal = 128 * 128;
            }
        },

        getProgress: function() {
            if (this.analysisTotal === 0) return 0;
            return Math.floor((this.analysisProgress / this.analysisTotal) * 100);
        },

        runAnalysisStep: function() {
            if (this.isAnalyzed) return true;
            var processed = 0;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            while (this.analysisProgress < this.analysisTotal && processed < 500) {
                var tileX = this.analysisProgress % mapWidth;
                var tileY = Math.floor(this.analysisProgress / mapWidth);
                try {
                    var tile = map.getTile(tileX, tileY);
                    if (tile && tile.elements) {
                        for (var i = 0; i < tile.numElements; i++) {
                            var element = tile.getElement(i);
                            if (element) {
                                if (element.type === 'footpath') {
                                    this.pathTiles.push({ x: tileX, y: tileY });
                                    this.totalPathTiles++;
                                    if (element.isQueue) {
                                        this.queueLocations.push({ x: tileX, y: tileY });
                                    }
                                } else if (element.type === 'track' && typeof element.ride === 'number') {
                                    this.rideLocations.push({ x: tileX, y: tileY, rideId: element.ride });
                                } else if (element.type === 'entrance') {
                                    this.entranceLocations.push({ x: tileX, y: tileY });
                                }
                            }
                        }
                    }
                } catch (e) {}
                this.analysisProgress++;
                processed++;
            }

            if (this.analysisProgress >= this.analysisTotal) {
                this.isAnalyzed = true;
                this.updateRideStats();
                return true;
            }
            return false;
        },

        updateRideStats: function() {
            try {
                var rides = map.rides;
                this.totalRides = 0;
                for (var i = 0; i < rides.length; i++) {
                    if (rides[i] && rides[i].classification === 'ride') {
                        this.totalRides++;
                    }
                }
            } catch (e) {}
        },

        updateLitterAndVandalism: function() {
            this.litterLocations.clear();
            this.vandalismLocations.clear();
            this.totalLitter = 0;
            this.totalVandalism = 0;
            try {
                var litter = map.getAllEntities('litter');
                for (var i = 0; i < litter.length; i++) {
                    var item = litter[i];
                    if (item) {
                        var tx = Math.floor(item.x / 32);
                        var ty = Math.floor(item.y / 32);
                        this.litterLocations.add(tx, ty, item);
                        this.totalLitter++;
                    }
                }
            } catch (e) {}
        },

        updateGuestDensity: function() {
            this.guestDensity.clear();
            var totalHappiness = 0;
            var guestCount = 0;
            try {
                var guests = map.getAllEntities('guest');
                this.totalGuests = guests.length;
                for (var i = 0; i < guests.length; i++) {
                    var guest = guests[i];
                    if (guest && typeof guest.x === 'number') {
                        var tx = Math.floor(guest.x / 32);
                        var ty = Math.floor(guest.y / 32);
                        this.guestDensity.add(tx, ty, guest);
                        if (typeof guest.happiness === 'number') {
                            totalHappiness += guest.happiness;
                            guestCount++;
                        }
                    }
                }
                this.averageGuestHappiness = guestCount > 0 ? totalHappiness / guestCount : 0;
            } catch (e) {}
        },

        getLitterHotspots: function(maxCount) {
            var hotspots = [];
            for (var key in this.litterLocations.cells) {
                if (this.litterLocations.cells.hasOwnProperty(key)) {
                    var items = this.litterLocations.cells[key];
                    if (items && items.length > 0) {
                        var parts = key.split(',');
                        hotspots.push({ x: parseInt(parts[0]), y: parseInt(parts[1]), count: items.length });
                    }
                }
            }
            hotspots.sort(function(a, b) { return b.count - a.count; });
            return hotspots.slice(0, maxCount || 10);
        },

        getGuestHotspots: function(maxCount) {
            var hotspots = [];
            for (var key in this.guestDensity.cells) {
                if (this.guestDensity.cells.hasOwnProperty(key)) {
                    var items = this.guestDensity.cells[key];
                    if (items && items.length > 0) {
                        var parts = key.split(',');
                        hotspots.push({
                            x: parseInt(parts[0]) * 16,
                            y: parseInt(parts[1]) * 16,
                            count: items.length
                        });
                    }
                }
            }
            hotspots.sort(function(a, b) { return b.count - a.count; });
            return hotspots.slice(0, maxCount || 10);
        }
    };

    // ============================================================
    // ACTION QUEUE (Multiplayer Safe)
    // ============================================================
    var ActionQueue = {
        queue: [],
        maxPerTick: 3,
        add: function(actionName, args, callback) {
            this.queue.push({ action: actionName, args: args, callback: callback });
        },
        process: function() {
            if (!NetworkHelper.canModifyGameState()) {
                this.queue = [];
                return;
            }
            var processed = 0;
            while (this.queue.length > 0 && processed < this.maxPerTick) {
                var item = this.queue.shift();
                try {
                    context.executeAction(item.action, item.args, item.callback || function() {});
                } catch (e) {}
                processed++;
            }
        }
    };

    // ============================================================
    // STAFF MANAGER
    // ============================================================
    var StaffManager = {
        allStaff: [],
        handymen: [],
        mechanics: [],
        security: [],
        entertainers: [],
        staffAssignments: {},
        lastStaffUpdate: 0,
        lastAnalysisUpdate: 0,
        lastAutoHireCheck: 0,
        lastAutoReanalyze: 0,
        lastAutoGenZones: 0,
        lastEventCheck: 0,
        tickCounter: 0,
        zonesNeedRegeneration: true,
        lastStaffCount: 0,
        statistics: {
            totalStaff: 0,
            handymenCount: 0,
            mechanicsCount: 0,
            securityCount: 0,
            entertainersCount: 0,
            staffHired: 0,
            ordersChanged: 0,
            patrolZonesSet: 0,
            patrolZonesFailed: 0,
            dispatchesMade: 0,
            lastFrameTime: 0,
            avgFrameTime: 0,
            autoReanalyzeCount: 0,
            autoGenZonesCount: 0,
            crimeDetected: 0,
            disgustComplaints: 0,
            newRidesDetected: 0,
            smartHires: { handymen: 0, mechanics: 0, security: 0, entertainers: 0 }
        },

        initialize: function() {
            ParkAnalyzer.startAnalysis();
            RideTracker.initialize();
        },

        getGameTick: function() {
            try { return date.ticksElapsed || 0; } catch (e) { return this.tickCounter; }
        },

        updateStaffLists: function() {
            this.allStaff = [];
            this.handymen = [];
            this.mechanics = [];
            this.security = [];
            this.entertainers = [];
            try {
                var staff = map.getAllEntities('staff');
                for (var i = 0; i < staff.length; i++) {
                    var member = staff[i];
                    if (!member) continue;
                    this.allStaff.push(member);
                    if (member.staffType === 'handyman') this.handymen.push(member);
                    else if (member.staffType === 'mechanic') this.mechanics.push(member);
                    else if (member.staffType === 'security') this.security.push(member);
                    else if (member.staffType === 'entertainer') this.entertainers.push(member);
                }
                this.statistics.totalStaff = this.allStaff.length;
                this.statistics.handymenCount = this.handymen.length;
                this.statistics.mechanicsCount = this.mechanics.length;
                this.statistics.securityCount = this.security.length;
                this.statistics.entertainersCount = this.entertainers.length;
                if (this.allStaff.length !== this.lastStaffCount) {
                    this.zonesNeedRegeneration = true;
                    this.lastStaffCount = this.allStaff.length;
                }
            } catch (e) {}
        },

        // ============================================================
        // SMART HIRING - Event-based detection
        // ============================================================
        checkSmartHiring: function() {
            if (!CONFIG.smartHiringEnabled || !CONFIG.autoHireEnabled) return;
            if (!NetworkHelper.canModifyGameState()) return;

            // 1. Check for new rides -> hire mechanics
            if (CONFIG.mechanicPerNewRide && RideTracker.checkForNewRides()) {
                var newRides = RideTracker.getNewRides();
                for (var i = 0; i < newRides.length; i++) {
                    this.statistics.newRidesDetected++;
                    if (CONFIG.mechanicAutoHire && this.mechanics.length < CONFIG.mechanicMaxCount) {
                        this.hireStaff('mechanic');
                        this.statistics.smartHires.mechanics++;
                        if (CONFIG.debugMode) {
                            console.log('[Staff AI] Smart hire: Mechanic for new ride');
                        }
                    }
                }
                this.zonesNeedRegeneration = true;
            }

            // 2. Check crime level -> hire security
            CrimeDetector.update();
            this.statistics.crimeDetected = CrimeDetector.getCrimeLevel();
            if (CONFIG.securityAutoHire && CrimeDetector.needsMoreSecurity()) {
                if (this.security.length < CONFIG.securityMaxCount) {
                    this.hireStaff('security');
                    this.statistics.smartHires.security++;
                    if (CONFIG.debugMode) {
                        console.log('[Staff AI] Smart hire: Security for crime level ' + this.statistics.crimeDetected);
                    }
                }
            }

            // 3. Check guest disgust/litter feedback -> hire handymen
            GuestFeedbackAnalyzer.update();
            this.statistics.disgustComplaints = GuestFeedbackAnalyzer.disgustCount;
            if (CONFIG.handymanAutoHire && GuestFeedbackAnalyzer.needsMoreHandymen()) {
                if (this.handymen.length < CONFIG.handymanMaxCount) {
                    this.hireStaff('handyman');
                    this.statistics.smartHires.handymen++;
                    if (CONFIG.debugMode) {
                        console.log('[Staff AI] Smart hire: Handyman for disgust complaints ' + this.statistics.disgustComplaints);
                    }
                }
            }

            // 4. Check happiness below 60% -> hire entertainers
            if (CONFIG.entertainerAutoHire && GuestFeedbackAnalyzer.needsMoreEntertainers()) {
                if (this.entertainers.length < CONFIG.entertainerMaxCount) {
                    this.hireStaff('entertainer');
                    this.statistics.smartHires.entertainers++;
                    if (CONFIG.debugMode) {
                        console.log('[Staff AI] Smart hire: Entertainer for low happiness ' + GuestFeedbackAnalyzer.happinessPercent + '%');
                    }
                }
            }
        },

        checkAutoHire: function() {
            if (!CONFIG.autoHireEnabled) return;
            if (!NetworkHelper.canModifyGameState()) return;
            try {
                var guestCount = this.statistics.totalStaff > 0 ? ParkAnalyzer.totalGuests : map.getAllEntities('guest').length;
                
                if (CONFIG.handymanAutoHire) {
                    var targetHandymen = Math.max(CONFIG.handymanMinCount, Math.min(CONFIG.handymanMaxCount, Math.ceil(guestCount * CONFIG.handymanTargetRatio)));
                    if (this.handymen.length < targetHandymen) {
                        this.hireStaff('handyman');
                    }
                }
                if (CONFIG.mechanicAutoHire) {
                    var targetMechanics = Math.max(CONFIG.mechanicMinCount, Math.min(CONFIG.mechanicMaxCount, Math.ceil(ParkAnalyzer.totalRides * CONFIG.mechanicTargetRatio)));
                    if (this.mechanics.length < targetMechanics) {
                        this.hireStaff('mechanic');
                    }
                }
                if (CONFIG.securityAutoHire) {
                    var targetSecurity = Math.max(CONFIG.securityMinCount, Math.min(CONFIG.securityMaxCount, Math.ceil(guestCount * CONFIG.securityTargetRatio)));
                    if (this.security.length < targetSecurity) {
                        this.hireStaff('security');
                    }
                }
                if (CONFIG.entertainerAutoHire) {
                    var targetEntertainers = Math.max(CONFIG.entertainerMinCount, Math.min(CONFIG.entertainerMaxCount, Math.ceil(guestCount * CONFIG.entertainerTargetRatio)));
                    if (this.entertainers.length < targetEntertainers) {
                        this.hireStaff('entertainer');
                    }
                }
            } catch (e) {}
        },

        hireStaff: function(staffType) {
            if (!NetworkHelper.canModifyGameState()) return;
            var staffTypeNum = 0;
            var orders = 0;
            if (staffType === 'handyman') {
                staffTypeNum = 0;
                if (CONFIG.handymanSweepEnabled) orders |= HANDYMAN_ORDERS.SWEEPING;
                if (CONFIG.handymanWaterEnabled) orders |= HANDYMAN_ORDERS.WATERING;
                if (CONFIG.handymanEmptyBinsEnabled) orders |= HANDYMAN_ORDERS.EMPTY_BINS;
                if (CONFIG.handymanMowEnabled) orders |= HANDYMAN_ORDERS.MOWING;
            } else if (staffType === 'mechanic') {
                staffTypeNum = 1;
                orders = MECHANIC_ORDERS.INSPECT | MECHANIC_ORDERS.FIX;
            } else if (staffType === 'security') {
                staffTypeNum = 2;
            } else if (staffType === 'entertainer') {
                staffTypeNum = 3;
            }
            var entertainerType = staffType === 'entertainer' ? DeterministicRandom.randomInt(0, 6, this.getGameTick()) : 0;
            var args = {
                autoPosition: true,
                staffType: staffTypeNum,
                entertainerType: entertainerType,
                staffOrders: orders
            };
            var self = this;
            ActionQueue.add('staffhire', args, function(result) {
                if (result.error === 0) {
                    self.statistics.staffHired++;
                    self.zonesNeedRegeneration = true;
                }
            });
        },

        setStaffPatrolArea: function(staffId, x1, y1, x2, y2, mode) {
            if (!NetworkHelper.canModifyGameState()) return;
            if (typeof staffId !== 'number' || staffId < 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}
            x1 = Math.max(0, Math.min(Math.floor(x1), mapWidth - 1));
            y1 = Math.max(0, Math.min(Math.floor(y1), mapHeight - 1));
            x2 = Math.max(x1, Math.min(Math.floor(x2), mapWidth - 1));
            y2 = Math.max(y1, Math.min(Math.floor(y2), mapHeight - 1));
            var args = { id: staffId, x1: x1 * 32, y1: y1 * 32, x2: x2 * 32, y2: y2 * 32, mode: mode };
            var self = this;
            ActionQueue.add('staffsetpatrolarea', args, function(result) {
                if (result.error === 0) self.statistics.patrolZonesSet++;
                else self.statistics.patrolZonesFailed++;
            });
        },

        generatePatrolZones: function() {
            if (!NetworkHelper.canModifyGameState()) return;
            if (!ParkAnalyzer.isAnalyzed) return;
            this.updateStaffLists();
            if (this.allStaff.length === 0) return;

            // Clear existing zones
            for (var i = 0; i < this.allStaff.length; i++) {
                var staff = this.allStaff[i];
                if (staff && typeof staff.id === 'number') {
                    this.setStaffPatrolArea(staff.id, 0, 0, 0, 0, 2);
                }
            }

            this.generateHandymanPatrolZones();
            this.generateMechanicPatrolZones();
            this.generateSecurityPatrolZones();
            this.generateEntertainerPatrolZones();
            this.zonesNeedRegeneration = false;
        },

        generateHandymanPatrolZones: function() {
            if (this.handymen.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}
            var zoneSize = CONFIG.patrolZoneSize;
            var zonesX = Math.ceil(mapWidth / zoneSize);
            var totalZones = zonesX * Math.ceil(mapHeight / zoneSize);

            for (var i = 0; i < this.handymen.length; i++) {
                var handyman = this.handymen[i];
                if (!handyman || typeof handyman.id !== 'number') continue;
                var zoneIndex = i % totalZones;
                var zx = zoneIndex % zonesX;
                var zy = Math.floor(zoneIndex / zonesX);
                this.setStaffPatrolArea(handyman.id, zx * zoneSize, zy * zoneSize, 
                    Math.min((zx + 1) * zoneSize + CONFIG.patrolZoneOverlap, mapWidth - 1),
                    Math.min((zy + 1) * zoneSize + CONFIG.patrolZoneOverlap, mapHeight - 1), 0);
            }
        },

        generateMechanicPatrolZones: function() {
            if (this.mechanics.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            // Use ride tracker for better zone coverage
            var rideIds = Object.keys(RideTracker.knownRides);
            if (rideIds.length === 0) {
                // Fallback to grid
                var zoneSize = CONFIG.patrolZoneSize * 2;
                var zonesX = Math.ceil(mapWidth / zoneSize);
                var totalZones = zonesX * Math.ceil(mapHeight / zoneSize);
                for (var k = 0; k < this.mechanics.length; k++) {
                    var mech = this.mechanics[k];
                    if (!mech || typeof mech.id !== 'number') continue;
                    var zoneIndex = k % totalZones;
                    var zx = zoneIndex % zonesX;
                    var zy = Math.floor(zoneIndex / zonesX);
                    this.setStaffPatrolArea(mech.id, zx * zoneSize, zy * zoneSize,
                        Math.min((zx + 1) * zoneSize, mapWidth - 1),
                        Math.min((zy + 1) * zoneSize, mapHeight - 1), 0);
                }
                return;
            }

            // Assign mechanics to ride groups based on entrance/exit coverage
            var ridesPerMechanic = Math.ceil(rideIds.length / this.mechanics.length);
            for (var i = 0; i < this.mechanics.length; i++) {
                var mechanic = this.mechanics[i];
                if (!mechanic || typeof mechanic.id !== 'number') continue;
                
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                var startIdx = i * ridesPerMechanic;
                var endIdx = Math.min(startIdx + ridesPerMechanic, rideIds.length);

                for (var j = startIdx; j < endIdx; j++) {
                    var rideId = parseInt(rideIds[j]);
                    var coverage = RideTracker.getRideCoverage(rideId);
                    if (coverage.minX !== Infinity) {
                        minX = Math.min(minX, coverage.minX);
                        minY = Math.min(minY, coverage.minY);
                        maxX = Math.max(maxX, coverage.maxX);
                        maxY = Math.max(maxY, coverage.maxY);
                    }
                }

                if (minX !== Infinity) {
                    this.setStaffPatrolArea(mechanic.id, 
                        Math.max(0, minX), Math.max(0, minY),
                        Math.min(mapWidth - 1, maxX), Math.min(mapHeight - 1, maxY), 0);
                }
            }
        },

        generateSecurityPatrolZones: function() {
            if (this.security.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            // Prioritize crime hotspots
            var crimeHotspots = CrimeDetector.getCrimeHotspots(this.security.length);
            var guestHotspots = ParkAnalyzer.getGuestHotspots(this.security.length);
            
            for (var i = 0; i < this.security.length; i++) {
                var guard = this.security[i];
                if (!guard || typeof guard.id !== 'number') continue;
                var centerX, centerY;
                
                if (crimeHotspots[i]) {
                    centerX = crimeHotspots[i].x;
                    centerY = crimeHotspots[i].y;
                } else if (guestHotspots[i]) {
                    centerX = guestHotspots[i].x;
                    centerY = guestHotspots[i].y;
                } else if (ParkAnalyzer.entranceLocations.length > 0) {
                    var entrance = ParkAnalyzer.entranceLocations[i % ParkAnalyzer.entranceLocations.length];
                    centerX = entrance.x;
                    centerY = entrance.y;
                } else {
                    centerX = mapWidth / 2;
                    centerY = mapHeight / 2;
                }
                var radius = CONFIG.patrolZoneSize;
                this.setStaffPatrolArea(guard.id, 
                    Math.max(0, centerX - radius), Math.max(0, centerY - radius),
                    Math.min(mapWidth - 1, centerX + radius), Math.min(mapHeight - 1, centerY + radius), 0);
            }
        },

        generateEntertainerPatrolZones: function() {
            if (this.entertainers.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            // Prioritize unhappy areas
            var unhappyAreas = GuestFeedbackAnalyzer.getUnhappyAreas();
            var guestHotspots = ParkAnalyzer.getGuestHotspots(this.entertainers.length);
            var targets = unhappyAreas.length > 0 ? unhappyAreas : guestHotspots;

            for (var i = 0; i < this.entertainers.length; i++) {
                var entertainer = this.entertainers[i];
                if (!entertainer || typeof entertainer.id !== 'number') continue;
                var target;
                if (targets.length > 0) {
                    target = targets[i % targets.length];
                } else if (ParkAnalyzer.entranceLocations.length > 0) {
                    target = ParkAnalyzer.entranceLocations[i % ParkAnalyzer.entranceLocations.length];
                } else {
                    target = { x: mapWidth / 2, y: mapHeight / 2 };
                }
                var radius = CONFIG.patrolZoneSize;
                this.setStaffPatrolArea(entertainer.id,
                    Math.max(0, target.x - radius), Math.max(0, target.y - radius),
                    Math.min(mapWidth - 1, target.x + radius), Math.min(mapHeight - 1, target.y + radius), 0);
            }
        },

        processHandymen: function() {
            if (!CONFIG.handymanEnabled || this.handymen.length === 0) return;
            ParkAnalyzer.updateLitterAndVandalism();
            for (var i = 0; i < this.handymen.length; i++) {
                var handyman = this.handymen[i];
                if (!handyman) continue;
                var orders = 0;
                if (CONFIG.handymanSweepEnabled) orders |= HANDYMAN_ORDERS.SWEEPING;
                if (CONFIG.handymanWaterEnabled) orders |= HANDYMAN_ORDERS.WATERING;
                if (CONFIG.handymanEmptyBinsEnabled) orders |= HANDYMAN_ORDERS.EMPTY_BINS;
                if (CONFIG.handymanMowEnabled) orders |= HANDYMAN_ORDERS.MOWING;
                if (handyman.orders !== orders) {
                    ActionQueue.add('staffsetorders', { id: handyman.id, staffOrders: orders }, function(r) {
                        if (r.error === 0) StaffManager.statistics.ordersChanged++;
                    });
                }
            }
        },

        onTick: function() {
            if (!CONFIG.enabled) return;
            var gameTick = this.getGameTick();
            this.tickCounter = gameTick;
            ActionQueue.process();

            if (!ParkAnalyzer.isAnalyzed) {
                ParkAnalyzer.runAnalysisStep();
                return;
            }

            // Event-based smart hiring check (more frequent)
            if (gameTick - this.lastEventCheck >= CONFIG.eventCheckInterval) {
                this.lastEventCheck = gameTick;
                this.checkSmartHiring();
            }

            if (gameTick - this.lastAnalysisUpdate >= CONFIG.analysisInterval) {
                this.lastAnalysisUpdate = gameTick;
                ParkAnalyzer.updateLitterAndVandalism();
                ParkAnalyzer.updateGuestDensity();
            }

            if (gameTick - this.lastStaffUpdate >= CONFIG.staffUpdateInterval) {
                this.lastStaffUpdate = gameTick;
                PerformanceMonitor.startFrame();
                this.updateStaffLists();
                this.processHandymen();
                var frameTime = PerformanceMonitor.endFrame();
                this.statistics.lastFrameTime = frameTime;
                this.statistics.avgFrameTime = PerformanceMonitor.getAverageFrameTime();
            }

            if (gameTick - this.lastAutoHireCheck >= CONFIG.autoHireCheckInterval) {
                this.lastAutoHireCheck = gameTick;
                this.checkAutoHire();
            }

            if (CONFIG.autoReanalyze && gameTick - this.lastAutoReanalyze >= CONFIG.autoReanalyzeInterval) {
                this.lastAutoReanalyze = gameTick;
                ParkAnalyzer.startAnalysis();
                this.statistics.autoReanalyzeCount++;
                this.zonesNeedRegeneration = true;
            }

            if (CONFIG.autoGenZones && gameTick - this.lastAutoGenZones >= CONFIG.autoGenZonesInterval) {
                this.lastAutoGenZones = gameTick;
                if (ParkAnalyzer.isAnalyzed && this.allStaff.length > 0) {
                    if (this.zonesNeedRegeneration || this.statistics.autoGenZonesCount === 0) {
                        this.generatePatrolZones();
                        this.statistics.autoGenZonesCount++;
                    }
                }
            }
        }
    };

    // ============================================================
    // UI MANAGER (Simplified for brevity)
    // ============================================================
    var UIManager = {
        mainWindow: null,
        windowId: 'staff-ai-mgr-v3',
        updateInterval: null,

        disposeUpdateInterval: function() {
            if (this.updateInterval !== null) {
                try { this.updateInterval.dispose(); } catch (e) {}
                this.updateInterval = null;
            }
        },

        syncAutoHireCheckboxes: function(checked) {
            CONFIG.handymanAutoHire = checked;
            CONFIG.mechanicAutoHire = checked;
            CONFIG.securityAutoHire = checked;
            CONFIG.entertainerAutoHire = checked;
            if (this.mainWindow) {
                try {
                    var widgets = ['chk_handyman_autohire', 'chk_mechanic_autohire', 'chk_security_autohire', 'chk_entertainer_autohire'];
                    for (var i = 0; i < widgets.length; i++) {
                        var w = this.mainWindow.findWidget(widgets[i]);
                        if (w) w.isChecked = checked;
                    }
                } catch (e) {}
            }
        },

        toggleWindow: function() {
            var existingWindow = ui.getWindow(this.windowId);
            if (existingWindow) existingWindow.close();
            else this.openWindow();
        },

        openWindow: function() {
            var existingWindow = ui.getWindow(this.windowId);
            if (existingWindow) { existingWindow.bringToFront(); return; }
            this.disposeUpdateInterval();
            var self = this;
            var windowWidth = 460;
            var windowHeight = 400;
            var contentY = 40;

            var allWidgets = [
                { type: 'button', name: 'btn_tab_0', x: 10, y: 20, width: 75, height: 14, text: 'Overview', isPressed: true, onClick: function() { self.switchTab(0); } },
                { type: 'button', name: 'btn_tab_1', x: 87, y: 20, width: 75, height: 14, text: 'Smart Hire', onClick: function() { self.switchTab(1); } },
                { type: 'button', name: 'btn_tab_2', x: 164, y: 20, width: 75, height: 14, text: 'Staff', onClick: function() { self.switchTab(2); } },
                { type: 'button', name: 'btn_tab_3', x: 241, y: 20, width: 75, height: 14, text: 'Detection', onClick: function() { self.switchTab(3); } },
                { type: 'button', name: 'btn_tab_4', x: 318, y: 20, width: 65, height: 14, text: 'Zones', onClick: function() { self.switchTab(4); } },
                { type: 'button', name: 'btn_tab_5', x: 385, y: 20, width: 65, height: 14, text: 'Stats', onClick: function() { self.switchTab(5); } },

                // Overview Tab
                { type: 'groupbox', name: 'grp_overview', x: 10, y: contentY, width: 440, height: 310, text: 'System Overview', isVisible: true },
                { type: 'label', name: 'lbl_mode', x: 20, y: contentY + 16, width: 200, height: 14, text: 'Mode: ' + NetworkHelper.getModeString(), isVisible: true },
                { type: 'label', name: 'lbl_analysis', x: 230, y: contentY + 16, width: 200, height: 14, text: 'Analysis: Pending', isVisible: true },
                { type: 'label', name: 'lbl_staff_total', x: 20, y: contentY + 34, width: 100, height: 14, text: 'Staff: 0', isVisible: true },
                { type: 'label', name: 'lbl_guests', x: 120, y: contentY + 34, width: 100, height: 14, text: 'Guests: 0', isVisible: true },
                { type: 'label', name: 'lbl_happiness', x: 230, y: contentY + 34, width: 100, height: 14, text: 'Happiness: 0%', isVisible: true },
                { type: 'label', name: 'lbl_litter', x: 340, y: contentY + 34, width: 100, height: 14, text: 'Litter: 0', isVisible: true },
                { type: 'label', name: 'lbl_handymen', x: 20, y: contentY + 54, width: 100, height: 14, text: 'Handymen: 0', isVisible: true },
                { type: 'label', name: 'lbl_mechanics', x: 120, y: contentY + 54, width: 100, height: 14, text: 'Mechanics: 0', isVisible: true },
                { type: 'label', name: 'lbl_security', x: 230, y: contentY + 54, width: 100, height: 14, text: 'Security: 0', isVisible: true },
                { type: 'label', name: 'lbl_entertainers', x: 340, y: contentY + 54, width: 100, height: 14, text: 'Entertainers: 0', isVisible: true },
                { type: 'label', name: 'lbl_crime', x: 20, y: contentY + 74, width: 200, height: 14, text: 'Crime Level: 0', isVisible: true },
                { type: 'label', name: 'lbl_disgust', x: 230, y: contentY + 74, width: 200, height: 14, text: 'Disgust Complaints: 0', isVisible: true },
                { type: 'label', name: 'lbl_rides', x: 20, y: contentY + 94, width: 200, height: 14, text: 'Rides Tracked: 0', isVisible: true },
                { type: 'label', name: 'lbl_new_rides', x: 230, y: contentY + 94, width: 200, height: 14, text: 'New Rides Detected: 0', isVisible: true },
                { type: 'checkbox', name: 'chk_enabled', x: 20, y: contentY + 120, width: 200, height: 14, text: 'Enable AI Manager', isChecked: CONFIG.enabled, isVisible: true, onChange: function(c) { CONFIG.enabled = c; } },
                { type: 'checkbox', name: 'chk_debug', x: 230, y: contentY + 120, width: 200, height: 14, text: 'Debug Mode', isChecked: CONFIG.debugMode, isVisible: true, onChange: function(c) { CONFIG.debugMode = c; } },
                { type: 'checkbox', name: 'chk_autohire', x: 20, y: contentY + 138, width: 200, height: 14, text: 'Auto-Hire Staff', isChecked: CONFIG.autoHireEnabled, isVisible: true, onChange: function(c) { CONFIG.autoHireEnabled = c; self.syncAutoHireCheckboxes(c); } },
                { type: 'checkbox', name: 'chk_smarthire', x: 230, y: contentY + 138, width: 200, height: 14, text: 'Smart Hiring (Event-Based)', isChecked: CONFIG.smartHiringEnabled, isVisible: true, onChange: function(c) { CONFIG.smartHiringEnabled = c; } },
                { type: 'checkbox', name: 'chk_autogen', x: 20, y: contentY + 156, width: 200, height: 14, text: 'Auto Gen Patrol Zones', isChecked: CONFIG.autoGenZones, isVisible: true, onChange: function(c) { CONFIG.autoGenZones = c; } },
                { type: 'checkbox', name: 'chk_autoreanalyze', x: 230, y: contentY + 156, width: 200, height: 14, text: 'Auto Re-analyze Park', isChecked: CONFIG.autoReanalyze, isVisible: true, onChange: function(c) { CONFIG.autoReanalyze = c; } },
                { type: 'button', name: 'btn_reanalyze', x: 20, y: contentY + 180, width: 130, height: 22, text: 'Re-analyze Park', isVisible: true, onClick: function() { ParkAnalyzer.startAnalysis(); RideTracker.scanAllRides(); StaffManager.zonesNeedRegeneration = true; } },
                { type: 'button', name: 'btn_genzones', x: 160, y: contentY + 180, width: 130, height: 22, text: 'Generate Zones', isVisible: true, onClick: function() { StaffManager.zonesNeedRegeneration = true; StaffManager.generatePatrolZones(); } },
                { type: 'button', name: 'btn_reset', x: 300, y: contentY + 180, width: 130, height: 22, text: 'Reset Stats', isVisible: true, onClick: function() { StaffManager.statistics.smartHires = { handymen: 0, mechanics: 0, security: 0, entertainers: 0 }; } },
                { type: 'label', name: 'lbl_smart_hires', x: 20, y: contentY + 210, width: 420, height: 14, text: 'Smart Hires: H:0 M:0 S:0 E:0', isVisible: true },
                { type: 'label', name: 'lbl_zones_set', x: 20, y: contentY + 228, width: 200, height: 14, text: 'Zones Set: 0', isVisible: true },
                { type: 'label', name: 'lbl_frame', x: 230, y: contentY + 228, width: 200, height: 14, text: 'Frame: 0ms', isVisible: true },

                // Smart Hire Tab
                { type: 'groupbox', name: 'grp_smarthire', x: 10, y: contentY, width: 440, height: 310, text: 'Smart Hiring Settings', isVisible: false },
                { type: 'label', name: 'lbl_sh_info', x: 20, y: contentY + 20, width: 420, height: 28, text: 'Smart hiring automatically hires staff based on real-time events:', isVisible: false },
                { type: 'checkbox', name: 'chk_mech_newride', x: 20, y: contentY + 50, width: 400, height: 14, text: 'Hire Mechanic when new ride is built', isChecked: CONFIG.mechanicPerNewRide, isVisible: false, onChange: function(c) { CONFIG.mechanicPerNewRide = c; } },
                { type: 'label', name: 'lbl_sh_crime', x: 20, y: contentY + 75, width: 420, height: 14, text: 'Crime Threshold for Security: ' + CONFIG.securityCrimeThreshold, isVisible: false },
                { type: 'label', name: 'lbl_sh_disgust', x: 20, y: contentY + 95, width: 420, height: 14, text: 'Disgust Threshold for Handyman: ' + CONFIG.handymanDisgustThreshold, isVisible: false },
                { type: 'label', name: 'lbl_sh_happy', x: 20, y: contentY + 115, width: 420, height: 14, text: 'Happiness Threshold for Entertainer: <' + CONFIG.entertainerHappinessThreshold + '%', isVisible: false },
                { type: 'checkbox', name: 'chk_handyman_autohire', x: 20, y: contentY + 145, width: 200, height: 14, text: 'Auto-Hire Handymen', isChecked: CONFIG.handymanAutoHire, isVisible: false, onChange: function(c) { CONFIG.handymanAutoHire = c; } },
                { type: 'checkbox', name: 'chk_mechanic_autohire', x: 230, y: contentY + 145, width: 200, height: 14, text: 'Auto-Hire Mechanics', isChecked: CONFIG.mechanicAutoHire, isVisible: false, onChange: function(c) { CONFIG.mechanicAutoHire = c; } },
                { type: 'checkbox', name: 'chk_security_autohire', x: 20, y: contentY + 165, width: 200, height: 14, text: 'Auto-Hire Security', isChecked: CONFIG.securityAutoHire, isVisible: false, onChange: function(c) { CONFIG.securityAutoHire = c; } },
                { type: 'checkbox', name: 'chk_entertainer_autohire', x: 230, y: contentY + 165, width: 200, height: 14, text: 'Auto-Hire Entertainers', isChecked: CONFIG.entertainerAutoHire, isVisible: false, onChange: function(c) { CONFIG.entertainerAutoHire = c; } },

                // Staff Tab
                { type: 'groupbox', name: 'grp_staff', x: 10, y: contentY, width: 440, height: 310, text: 'Manual Staff Hiring', isVisible: false },
                { type: 'button', name: 'btn_hire_handyman', x: 20, y: contentY + 30, width: 200, height: 24, text: 'Hire Handyman', isVisible: false, onClick: function() { StaffManager.hireStaff('handyman'); } },
                { type: 'button', name: 'btn_hire_mechanic', x: 230, y: contentY + 30, width: 200, height: 24, text: 'Hire Mechanic', isVisible: false, onClick: function() { StaffManager.hireStaff('mechanic'); } },
                { type: 'button', name: 'btn_hire_security', x: 20, y: contentY + 60, width: 200, height: 24, text: 'Hire Security', isVisible: false, onClick: function() { StaffManager.hireStaff('security'); } },
                { type: 'button', name: 'btn_hire_entertainer', x: 230, y: contentY + 60, width: 200, height: 24, text: 'Hire Entertainer', isVisible: false, onClick: function() { StaffManager.hireStaff('entertainer'); } },

                // Detection Tab  
                { type: 'groupbox', name: 'grp_detect', x: 10, y: contentY, width: 440, height: 310, text: 'Detection Status', isVisible: false },
                { type: 'label', name: 'lbl_det_rides', x: 20, y: contentY + 20, width: 400, height: 14, text: 'Rides Tracked: 0', isVisible: false },
                { type: 'label', name: 'lbl_det_crime', x: 20, y: contentY + 38, width: 400, height: 14, text: 'Crime Level: 0 (threshold: ' + CONFIG.securityCrimeThreshold + ')', isVisible: false },
                { type: 'label', name: 'lbl_det_disgust', x: 20, y: contentY + 56, width: 400, height: 14, text: 'Disgust Complaints: 0 (threshold: ' + CONFIG.handymanDisgustThreshold + ')', isVisible: false },
                { type: 'label', name: 'lbl_det_happiness', x: 20, y: contentY + 74, width: 400, height: 14, text: 'Guest Happiness: 0% (threshold: <' + CONFIG.entertainerHappinessThreshold + '%)', isVisible: false },
                { type: 'label', name: 'lbl_det_litter', x: 20, y: contentY + 92, width: 400, height: 14, text: 'Litter Count: 0', isVisible: false },
                { type: 'label', name: 'lbl_det_action', x: 20, y: contentY + 120, width: 400, height: 14, text: 'Action Needed: None', isVisible: false },

                // Zones Tab
                { type: 'groupbox', name: 'grp_zones', x: 10, y: contentY, width: 440, height: 310, text: 'Patrol Zone Settings', isVisible: false },
                { type: 'label', name: 'lbl_zone_size', x: 20, y: contentY + 20, width: 200, height: 14, text: 'Zone Size: ' + CONFIG.patrolZoneSize, isVisible: false },
                { type: 'label', name: 'lbl_zone_overlap', x: 230, y: contentY + 20, width: 200, height: 14, text: 'Overlap: ' + CONFIG.patrolZoneOverlap, isVisible: false },
                { type: 'label', name: 'lbl_zone_info', x: 20, y: contentY + 45, width: 420, height: 28, text: 'Mechanic zones are auto-generated based on ride entrance/exit paths.', isVisible: false },

                // Stats Tab
                { type: 'groupbox', name: 'grp_stats', x: 10, y: contentY, width: 440, height: 310, text: 'Statistics', isVisible: false },
                { type: 'label', name: 'lbl_stat_hired', x: 20, y: contentY + 20, width: 200, height: 14, text: 'Staff Hired: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_zones', x: 230, y: contentY + 20, width: 200, height: 14, text: 'Zones Set: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_sh_h', x: 20, y: contentY + 40, width: 200, height: 14, text: 'Smart Hire Handymen: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_sh_m', x: 230, y: contentY + 40, width: 200, height: 14, text: 'Smart Hire Mechanics: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_sh_s', x: 20, y: contentY + 60, width: 200, height: 14, text: 'Smart Hire Security: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_sh_e', x: 230, y: contentY + 60, width: 200, height: 14, text: 'Smart Hire Entertainers: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_newrides', x: 20, y: contentY + 80, width: 200, height: 14, text: 'New Rides Detected: 0', isVisible: false },
                { type: 'label', name: 'lbl_stat_frame', x: 230, y: contentY + 80, width: 200, height: 14, text: 'Avg Frame: 0ms', isVisible: false }
            ];

            this.mainWindow = ui.openWindow({
                classification: this.windowId,
                title: 'Staff AI Manager v3.0 (Smart Detection)',
                x: Math.floor((ui.width - windowWidth) / 2),
                y: Math.floor((ui.height - windowHeight) / 2),
                width: windowWidth,
                height: windowHeight,
                colours: [24, 24],
                widgets: allWidgets,
                onClose: function() { self.mainWindow = null; self.disposeUpdateInterval(); }
            });

            this.updateInterval = context.setInterval(function() { self.updateDisplay(); }, 500);
        },

        switchTab: function(tabIndex) {
            if (!this.mainWindow) return;
            for (var t = 0; t < 6; t++) {
                var btn = this.mainWindow.findWidget('btn_tab_' + t);
                if (btn) btn.isPressed = (t === tabIndex);
            }

            var tabWidgets = {
                0: ['grp_overview', 'lbl_mode', 'lbl_analysis', 'lbl_staff_total', 'lbl_guests', 'lbl_happiness', 'lbl_litter', 'lbl_handymen', 'lbl_mechanics', 'lbl_security', 'lbl_entertainers', 'lbl_crime', 'lbl_disgust', 'lbl_rides', 'lbl_new_rides', 'chk_enabled', 'chk_debug', 'chk_autohire', 'chk_smarthire', 'chk_autogen', 'chk_autoreanalyze', 'btn_reanalyze', 'btn_genzones', 'btn_reset', 'lbl_smart_hires', 'lbl_zones_set', 'lbl_frame'],
                1: ['grp_smarthire', 'lbl_sh_info', 'chk_mech_newride', 'lbl_sh_crime', 'lbl_sh_disgust', 'lbl_sh_happy', 'chk_handyman_autohire', 'chk_mechanic_autohire', 'chk_security_autohire', 'chk_entertainer_autohire'],
                2: ['grp_staff', 'btn_hire_handyman', 'btn_hire_mechanic', 'btn_hire_security', 'btn_hire_entertainer'],
                3: ['grp_detect', 'lbl_det_rides', 'lbl_det_crime', 'lbl_det_disgust', 'lbl_det_happiness', 'lbl_det_litter', 'lbl_det_action'],
                4: ['grp_zones', 'lbl_zone_size', 'lbl_zone_overlap', 'lbl_zone_info'],
                5: ['grp_stats', 'lbl_stat_hired', 'lbl_stat_zones', 'lbl_stat_sh_h', 'lbl_stat_sh_m', 'lbl_stat_sh_s', 'lbl_stat_sh_e', 'lbl_stat_newrides', 'lbl_stat_frame']
            };

            for (var tab in tabWidgets) {
                if (tabWidgets.hasOwnProperty(tab)) {
                    var widgets = tabWidgets[tab];
                    for (var i = 0; i < widgets.length; i++) {
                        var w = this.mainWindow.findWidget(widgets[i]);
                        if (w) w.isVisible = false;
                    }
                }
            }
            var currentWidgets = tabWidgets[tabIndex] || [];
            for (var j = 0; j < currentWidgets.length; j++) {
                var widget = this.mainWindow.findWidget(currentWidgets[j]);
                if (widget) widget.isVisible = true;
            }
        },

        updateLabel: function(name, text) {
            if (this.mainWindow) {
                var label = this.mainWindow.findWidget(name);
                if (label) label.text = text;
            }
        },

        updateDisplay: function() {
            if (!this.mainWindow) return;
            var s = StaffManager.statistics;
            var sh = s.smartHires;

            // Overview
            this.updateLabel('lbl_analysis', 'Analysis: ' + (ParkAnalyzer.isAnalyzed ? 'Complete' : ParkAnalyzer.getProgress() + '%'));
            this.updateLabel('lbl_staff_total', 'Staff: ' + s.totalStaff);
            this.updateLabel('lbl_guests', 'Guests: ' + ParkAnalyzer.totalGuests);
            this.updateLabel('lbl_happiness', 'Happiness: ' + GuestFeedbackAnalyzer.happinessPercent + '%');
            this.updateLabel('lbl_litter', 'Litter: ' + ParkAnalyzer.totalLitter);
            this.updateLabel('lbl_handymen', 'Handymen: ' + s.handymenCount);
            this.updateLabel('lbl_mechanics', 'Mechanics: ' + s.mechanicsCount);
            this.updateLabel('lbl_security', 'Security: ' + s.securityCount);
            this.updateLabel('lbl_entertainers', 'Entertainers: ' + s.entertainersCount);
            this.updateLabel('lbl_crime', 'Crime Level: ' + s.crimeDetected);
            this.updateLabel('lbl_disgust', 'Disgust Complaints: ' + s.disgustComplaints);
            this.updateLabel('lbl_rides', 'Rides Tracked: ' + Object.keys(RideTracker.knownRides).length);
            this.updateLabel('lbl_new_rides', 'New Rides Detected: ' + s.newRidesDetected);
            this.updateLabel('lbl_smart_hires', 'Smart Hires: H:' + sh.handymen + ' M:' + sh.mechanics + ' S:' + sh.security + ' E:' + sh.entertainers);
            this.updateLabel('lbl_zones_set', 'Zones Set: ' + s.patrolZonesSet);
            this.updateLabel('lbl_frame', 'Frame: ' + s.lastFrameTime.toFixed(1) + 'ms');

            // Detection tab
            this.updateLabel('lbl_det_rides', 'Rides Tracked: ' + Object.keys(RideTracker.knownRides).length);
            this.updateLabel('lbl_det_crime', 'Crime Level: ' + s.crimeDetected + ' (threshold: ' + CONFIG.securityCrimeThreshold + ')');
            this.updateLabel('lbl_det_disgust', 'Disgust Complaints: ' + s.disgustComplaints + ' (threshold: ' + CONFIG.handymanDisgustThreshold + ')');
            this.updateLabel('lbl_det_happiness', 'Guest Happiness: ' + GuestFeedbackAnalyzer.happinessPercent + '% (threshold: <' + CONFIG.entertainerHappinessThreshold + '%)');
            this.updateLabel('lbl_det_litter', 'Litter Count: ' + ParkAnalyzer.totalLitter);
            
            var actions = [];
            if (CrimeDetector.needsMoreSecurity()) actions.push('Security');
            if (GuestFeedbackAnalyzer.needsMoreHandymen()) actions.push('Handyman');
            if (GuestFeedbackAnalyzer.needsMoreEntertainers()) actions.push('Entertainer');
            this.updateLabel('lbl_det_action', 'Action Needed: ' + (actions.length > 0 ? actions.join(', ') : 'None'));

            // Stats tab
            this.updateLabel('lbl_stat_hired', 'Staff Hired: ' + s.staffHired);
            this.updateLabel('lbl_stat_zones', 'Zones Set: ' + s.patrolZonesSet);
            this.updateLabel('lbl_stat_sh_h', 'Smart Hire Handymen: ' + sh.handymen);
            this.updateLabel('lbl_stat_sh_m', 'Smart Hire Mechanics: ' + sh.mechanics);
            this.updateLabel('lbl_stat_sh_s', 'Smart Hire Security: ' + sh.security);
            this.updateLabel('lbl_stat_sh_e', 'Smart Hire Entertainers: ' + sh.entertainers);
            this.updateLabel('lbl_stat_newrides', 'New Rides Detected: ' + s.newRidesDetected);
            this.updateLabel('lbl_stat_frame', 'Avg Frame: ' + s.avgFrameTime.toFixed(2) + 'ms');
        }
    };

    // ============================================================
    // MAIN
    // ============================================================
    function main() {
        StaffManager.initialize();
        if (typeof ui !== 'undefined') {
            ui.registerMenuItem('Staff AI Manager', function() { UIManager.toggleWindow(); });
        }
        context.subscribe('interval.tick', function() {
            try { StaffManager.onTick(); } catch (e) {
                if (CONFIG.debugMode) console.log('[Staff AI Manager] Error: ' + e);
            }
        });
        context.subscribe('map.change', function() {
            ParkAnalyzer.startAnalysis();
            RideTracker.knownRides = {};
            RideTracker.scanAllRides();
            StaffManager.staffAssignments = {};
            StaffManager.zonesNeedRegeneration = true;
        });
        console.log('[Staff AI Manager v3.0] Loaded - Smart Detection & Event-Based Hiring!');
        console.log('[Staff AI Manager v3.0] Features: Ride tracking, Crime detection, Guest feedback, Happiness monitoring');
    }

    registerPlugin({
        name: 'Staff AI Manager',
        version: '3.0.0',
        authors: ['CodingFleet'],
        type: 'remote',
        licence: 'MIT',
        targetApiVersion: 77,
        minApiVersion: 34,
        main: main
    });
})();
