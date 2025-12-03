/**
 * Staff AI Manager Plugin for OpenRCT2
 * Version: 2.2.0 - Multiplayer Desync Fix
 * 
 * MULTIPLAYER DESYNC FIXES:
 * 1. Removed direct entity.destination assignments (causes desync)
 * 2. Replaced Math.random() with deterministic seeded random using game ticks
 * 3. All game state modifications use context.executeAction() for proper sync
 * 4. tickCounter now uses date.ticksElapsed for consistency across clients
 * 5. Added proper action queuing to prevent race conditions
 * 6. Removed Date.now() from game logic (only used for local performance monitoring)
 * 
 * 100% Multiplayer Compatible - Server-side only (type: 'remote')
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
        autoHireCheckInterval: 300,
        patrolZoneUpdateInterval: 600,
        autoReanalyzeInterval: 1200,
        autoGenZonesInterval: 1000,
        maxStaffPerTick: 5,
        frameBudgetMs: 2.0,
        
        // Handyman settings
        handymanEnabled: true,
        handymanAutoHire: true,
        handymanTargetRatio: 0.01,
        handymanMinCount: 2,
        handymanMaxCount: 50,
        handymanLitterThreshold: 5,
        handymanSweepEnabled: true,
        handymanMowEnabled: false,
        handymanWaterEnabled: true,
        handymanEmptyBinsEnabled: true,
        handymanPriorityDispatch: true,
        
        // Mechanic settings
        mechanicEnabled: true,
        mechanicAutoHire: true,
        mechanicTargetRatio: 0.1,
        mechanicMinCount: 1,
        mechanicMaxCount: 30,
        mechanicPreventiveEnabled: true,
        mechanicInspectionPriority: true,
        mechanicBreakdownRadius: 30,
        
        // Security settings
        securityEnabled: true,
        securityAutoHire: true,
        securityTargetRatio: 0.002,
        securityMinCount: 0,
        securityMaxCount: 20,
        securityHotspotPatrol: true,
        securityVandalismResponse: true,
        
        // Entertainer settings
        entertainerEnabled: true,
        entertainerAutoHire: true,
        entertainerTargetRatio: 0.001,
        entertainerMinCount: 0,
        entertainerMaxCount: 20,
        entertainerHappinessZones: true,
        entertainerVariety: true,
        
        // Automation settings
        autoHireEnabled: true,
        autoFireEnabled: false,
        autoHireDelay: 600,
        autoPatrolZones: true,
        autoReanalyze: true,
        autoGenZones: true,
        patrolZoneSize: 15,
        patrolZoneOverlap: 2,
        
        // Energy management
        energyManagement: true,
        lowEnergyThreshold: 40,
        criticalEnergyThreshold: 25,
        pathfindingIntegration: true
    };

    // Staff order flags
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
    // Uses game tick as seed for consistency across all clients
    // ============================================================
    var DeterministicRandom = {
        // Simple seeded random using game ticks
        // This ensures all clients generate the same "random" values
        getSeed: function() {
            try {
                return date.ticksElapsed || 0;
            } catch (e) {
                return 0;
            }
        },
        
        // Deterministic random 0-1 based on seed and offset
        random: function(offset) {
            var seed = this.getSeed() + (offset || 0);
            var x = Math.sin(seed * 12.9898) * 43758.5453;
            return x - Math.floor(x);
        },
        
        // Deterministic random integer in range [min, max]
        randomInt: function(min, max, offset) {
            return Math.floor(this.random(offset) * (max - min + 1)) + min;
        }
    };

    // ============================================================
    // NETWORK HELPER
    // ============================================================
    var NetworkHelper = {
        getMode: function() {
            try {
                return network.mode;
            } catch (e) {
                return 'none';
            }
        },
        isServer: function() {
            var mode = this.getMode();
            return mode === 'none' || mode === 'server';
        },
        isClient: function() {
            return this.getMode() === 'client';
        },
        isMultiplayer: function() {
            var mode = this.getMode();
            return mode === 'server' || mode === 'client';
        },
        getPlayerCount: function() {
            try {
                if (this.isMultiplayer()) {
                    return network.numPlayers || 1;
                }
                return 1;
            } catch (e) {
                return 1;
            }
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
    // PERFORMANCE MONITOR (Local only - no game state)
    // ============================================================
    var PerformanceMonitor = {
        frameStartTime: 0,
        frameTimes: [],
        startFrame: function() {
            // Date.now() is safe here - only used for local performance display
            this.frameStartTime = Date.now();
        },
        getElapsedMs: function() {
            return Date.now() - this.frameStartTime;
        },
        endFrame: function() {
            var elapsed = this.getElapsedMs();
            this.frameTimes.push(elapsed);
            if (this.frameTimes.length > 30) {
                this.frameTimes.shift();
            }
            return elapsed;
        },
        getAverageFrameTime: function() {
            if (this.frameTimes.length === 0) return 0;
            var sum = 0;
            for (var i = 0; i < this.frameTimes.length; i++) {
                sum += this.frameTimes[i];
            }
            return sum / this.frameTimes.length;
        }
    };

    // ============================================================
    // SPATIAL HASH (Read-only analysis - no desync risk)
    // ============================================================
    function SpatialHash(cellSize) {
        this.cellSize = cellSize || 16;
        this.cells = {};
    }
    SpatialHash.prototype.getKey = function(x, y) {
        var cx = Math.floor(x / this.cellSize);
        var cy = Math.floor(y / this.cellSize);
        return cx + ',' + cy;
    };
    SpatialHash.prototype.add = function(x, y, value) {
        var key = this.getKey(x, y);
        if (!this.cells[key]) {
            this.cells[key] = [];
        }
        this.cells[key].push({ x: x, y: y, value: value });
    };
    SpatialHash.prototype.get = function(x, y) {
        var key = this.getKey(x, y);
        return this.cells[key] || [];
    };
    SpatialHash.prototype.clear = function() {
        this.cells = {};
    };
    SpatialHash.prototype.count = function() {
        var total = 0;
        for (var key in this.cells) {
            if (this.cells.hasOwnProperty(key)) {
                total += this.cells[key].length;
            }
        }
        return total;
    };

    // ============================================================
    // PARK ANALYZER (Read-only - no desync risk)
    // ============================================================
    var ParkAnalyzer = {
        litterLocations: new SpatialHash(8),
        vandalismLocations: new SpatialHash(8),
        guestDensity: new SpatialHash(16),
        pathTiles: [],
        rideLocations: [],
        shopLocations: [],
        entranceLocations: [],
        queueLocations: [],
        totalPathTiles: 0,
        totalLitter: 0,
        totalVandalism: 0,
        totalRides: 0,
        totalShops: 0,
        totalGuests: 0,
        averageGuestHappiness: 0,
        isAnalyzed: false,
        analysisProgress: 0,
        analysisTotal: 0,
        lastAnalysisTime: 0,
        analysisCount: 0,

        startAnalysis: function() {
            this.litterLocations.clear();
            this.vandalismLocations.clear();
            this.guestDensity.clear();
            this.pathTiles = [];
            this.rideLocations = [];
            this.shopLocations = [];
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
            var mapWidth = 128;
            var mapHeight = 128;
            try {
                mapWidth = map.size.x;
                mapHeight = map.size.y;
            } catch (e) {}

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
                                } else if (element.type === 'track') {
                                    if (typeof element.ride === 'number') {
                                        this.rideLocations.push({ x: tileX, y: tileY, rideId: element.ride });
                                    }
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
                // Use game ticks instead of Date.now() for consistency
                try {
                    this.lastAnalysisTime = date.ticksElapsed;
                } catch (e) {
                    this.lastAnalysisTime = 0;
                }
                this.analysisCount++;
                this.updateRideStats();
                return true;
            }
            return false;
        },

        updateRideStats: function() {
            try {
                var rides = map.rides;
                this.totalRides = 0;
                this.totalShops = 0;
                for (var i = 0; i < rides.length; i++) {
                    var ride = rides[i];
                    if (ride.classification === 'ride') {
                        this.totalRides++;
                    } else {
                        this.totalShops++;
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

            for (var j = 0; j < this.pathTiles.length && j < 200; j++) {
                var pathTile = this.pathTiles[j];
                try {
                    var tile = map.getTile(pathTile.x, pathTile.y);
                    if (tile) {
                        for (var k = 0; k < tile.numElements; k++) {
                            var element = tile.getElement(k);
                            if (element && element.type === 'footpath') {
                                if (element.isBroken) {
                                    this.vandalismLocations.add(pathTile.x, pathTile.y, element);
                                    this.totalVandalism++;
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
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
                    if (guest && typeof guest.x === 'number' && typeof guest.y === 'number') {
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
                        hotspots.push({
                            x: parseInt(parts[0]),
                            y: parseInt(parts[1]),
                            count: items.length
                        });
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
                        var cx = parseInt(parts[0]) * this.guestDensity.cellSize;
                        var cy = parseInt(parts[1]) * this.guestDensity.cellSize;
                        hotspots.push({ x: cx, y: cy, count: items.length });
                    }
                }
            }
            hotspots.sort(function(a, b) { return b.count - a.count; });
            return hotspots.slice(0, maxCount || 10);
        }
    };

    // ============================================================
    // ACTION QUEUE (Prevents race conditions in multiplayer)
    // ============================================================
    var ActionQueue = {
        queue: [],
        processing: false,
        maxPerTick: 3,
        
        add: function(actionName, args, callback) {
            this.queue.push({
                action: actionName,
                args: args,
                callback: callback
            });
        },
        
        process: function() {
            if (this.processing || this.queue.length === 0) return;
            if (!NetworkHelper.canModifyGameState()) {
                this.queue = []; // Clear queue on clients
                return;
            }
            
            this.processing = true;
            var processed = 0;
            
            while (this.queue.length > 0 && processed < this.maxPerTick) {
                var item = this.queue.shift();
                try {
                    context.executeAction(item.action, item.args, item.callback || function() {});
                } catch (e) {
                    if (CONFIG.debugMode) {
                        console.log('[Staff AI Manager] Action error: ' + e);
                    }
                }
                processed++;
            }
            
            this.processing = false;
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
        staffPerformance: {},
        lastStaffUpdate: 0,
        lastAnalysisUpdate: 0,
        lastAutoHireCheck: 0,
        lastAutoReanalyze: 0,
        lastAutoGenZones: 0,
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
            staffFired: 0,
            ordersChanged: 0,
            patrolZonesSet: 0,
            patrolZonesFailed: 0,
            dispatchesMade: 0,
            litterCleaned: 0,
            ridesFixed: 0,
            ridesInspected: 0,
            vandalsStopped: 0,
            lastFrameTime: 0,
            avgFrameTime: 0,
            autoReanalyzeCount: 0,
            autoGenZonesCount: 0
        },

        initialize: function() {
            ParkAnalyzer.startAnalysis();
        },

        resetStatistics: function() {
            var preserved = {
                autoReanalyzeCount: this.statistics.autoReanalyzeCount,
                autoGenZonesCount: this.statistics.autoGenZonesCount
            };
            this.statistics = {
                totalStaff: 0,
                handymenCount: 0,
                mechanicsCount: 0,
                securityCount: 0,
                entertainersCount: 0,
                staffHired: 0,
                staffFired: 0,
                ordersChanged: 0,
                patrolZonesSet: 0,
                patrolZonesFailed: 0,
                dispatchesMade: 0,
                litterCleaned: 0,
                ridesFixed: 0,
                ridesInspected: 0,
                vandalsStopped: 0,
                lastFrameTime: 0,
                avgFrameTime: 0,
                autoReanalyzeCount: preserved.autoReanalyzeCount,
                autoGenZonesCount: preserved.autoGenZonesCount
            };
        },

        // Use game ticks for consistent timing across all clients
        getGameTick: function() {
            try {
                return date.ticksElapsed || 0;
            } catch (e) {
                return this.tickCounter;
            }
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
                    if (member.staffType === 'handyman') {
                        this.handymen.push(member);
                    } else if (member.staffType === 'mechanic') {
                        this.mechanics.push(member);
                    } else if (member.staffType === 'security') {
                        this.security.push(member);
                    } else if (member.staffType === 'entertainer') {
                        this.entertainers.push(member);
                    }
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

        getRidesNeedingAttention: function() {
            var rides = [];
            try {
                var allRides = map.rides;
                for (var i = 0; i < allRides.length; i++) {
                    var ride = allRides[i];
                    if (!ride || ride.classification !== 'ride') continue;
                    if (ride.status === 'broken' || (ride.downtime && ride.downtime > 50)) {
                        rides.push(ride);
                    }
                }
            } catch (e) {}
            return rides;
        },

        checkAutoHire: function() {
            if (!CONFIG.autoHireEnabled) return;
            if (!NetworkHelper.canModifyGameState()) return;
            
            try {
                var guestCount = map.getAllEntities('guest').length;
                
                if (CONFIG.handymanAutoHire) {
                    var targetHandymen = Math.max(CONFIG.handymanMinCount, 
                        Math.min(CONFIG.handymanMaxCount, Math.ceil(guestCount * CONFIG.handymanTargetRatio)));
                    if (this.handymen.length < targetHandymen) {
                        this.hireStaff('handyman');
                    }
                }
                
                if (CONFIG.mechanicAutoHire) {
                    var targetMechanics = Math.max(CONFIG.mechanicMinCount, 
                        Math.min(CONFIG.mechanicMaxCount, Math.ceil(ParkAnalyzer.totalRides * CONFIG.mechanicTargetRatio)));
                    if (this.mechanics.length < targetMechanics) {
                        this.hireStaff('mechanic');
                    }
                }
                
                if (CONFIG.securityAutoHire) {
                    var targetSecurity = Math.max(CONFIG.securityMinCount, 
                        Math.min(CONFIG.securityMaxCount, Math.ceil(guestCount * CONFIG.securityTargetRatio)));
                    if (this.security.length < targetSecurity) {
                        this.hireStaff('security');
                    }
                }
                
                if (CONFIG.entertainerAutoHire) {
                    var targetEntertainers = Math.max(CONFIG.entertainerMinCount, 
                        Math.min(CONFIG.entertainerMaxCount, Math.ceil(guestCount * CONFIG.entertainerTargetRatio)));
                    if (this.entertainers.length < targetEntertainers) {
                        this.hireStaff('entertainer');
                    }
                }
            } catch (e) {}
        },

        getLowHappinessAreas: function() {
            var lowAreas = [];
            for (var key in ParkAnalyzer.guestDensity.cells) {
                if (!ParkAnalyzer.guestDensity.cells.hasOwnProperty(key)) continue;
                var items = ParkAnalyzer.guestDensity.cells[key];
                if (items && items.length > 3) {
                    var avgHappy = 0;
                    var validCount = 0;
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].value && typeof items[i].value.happiness === 'number') {
                            avgHappy += items[i].value.happiness;
                            validCount++;
                        }
                    }
                    if (validCount > 0) {
                        avgHappy = avgHappy / validCount;
                        if (avgHappy < 150) {
                            var parts = key.split(',');
                            lowAreas.push({
                                x: parseInt(parts[0]) * ParkAnalyzer.guestDensity.cellSize,
                                y: parseInt(parts[1]) * ParkAnalyzer.guestDensity.cellSize,
                                happiness: avgHappy
                            });
                        }
                    }
                }
            }
            return lowAreas;
        },

        // MULTIPLAYER SAFE: Uses executeAction via ActionQueue
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

            // Use deterministic random for entertainer type
            var entertainerType = 0;
            if (staffType === 'entertainer') {
                entertainerType = DeterministicRandom.randomInt(0, 6, this.getGameTick());
            }

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

        // MULTIPLAYER SAFE: Uses executeAction via ActionQueue
        setStaffOrders: function(staffId, orders) {
            if (!NetworkHelper.canModifyGameState()) return;
            
            var args = {
                id: staffId,
                staffOrders: orders
            };

            var self = this;
            ActionQueue.add('staffsetorders', args, function(result) {
                if (result.error === 0) {
                    self.statistics.ordersChanged++;
                }
            });
        },

        // MULTIPLAYER SAFE: Uses executeAction via ActionQueue
        setStaffPatrolArea: function(staffId, x1, y1, x2, y2, mode) {
            if (!NetworkHelper.canModifyGameState()) return;
            if (typeof staffId !== 'number' || staffId < 0) return;

            var mapWidth = 128;
            var mapHeight = 128;
            try {
                mapWidth = map.size.x;
                mapHeight = map.size.y;
            } catch (e) {}

            x1 = Math.max(0, Math.min(Math.floor(x1), mapWidth - 1));
            y1 = Math.max(0, Math.min(Math.floor(y1), mapHeight - 1));
            x2 = Math.max(x1, Math.min(Math.floor(x2), mapWidth - 1));
            y2 = Math.max(y1, Math.min(Math.floor(y2), mapHeight - 1));

            var args = {
                id: staffId,
                x1: x1 * 32,
                y1: y1 * 32,
                x2: x2 * 32,
                y2: y2 * 32,
                mode: mode
            };

            var self = this;
            ActionQueue.add('staffsetpatrolarea', args, function(result) {
                if (result.error === 0) {
                    self.statistics.patrolZonesSet++;
                } else {
                    self.statistics.patrolZonesFailed++;
                }
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
            var zonesY = Math.ceil(mapHeight / zoneSize);
            var totalZones = zonesX * zonesY;

            for (var i = 0; i < this.handymen.length; i++) {
                var handyman = this.handymen[i];
                if (!handyman || typeof handyman.id !== 'number') continue;
                var zoneIndex = i % totalZones;
                var zx = zoneIndex % zonesX;
                var zy = Math.floor(zoneIndex / zonesX);
                var x1 = zx * zoneSize;
                var y1 = zy * zoneSize;
                var x2 = Math.min((zx + 1) * zoneSize + CONFIG.patrolZoneOverlap, mapWidth - 1);
                var y2 = Math.min((zy + 1) * zoneSize + CONFIG.patrolZoneOverlap, mapHeight - 1);
                this.setStaffPatrolArea(handyman.id, x1, y1, x2, y2, 0);
            }
        },

        generateMechanicPatrolZones: function() {
            if (this.mechanics.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            if (ParkAnalyzer.rideLocations.length === 0) {
                var zoneSize = CONFIG.patrolZoneSize * 2;
                var zonesX = Math.ceil(mapWidth / zoneSize);
                var zonesY = Math.ceil(mapHeight / zoneSize);
                var totalZones = zonesX * zonesY;
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

            var ridesPerMechanic = Math.ceil(ParkAnalyzer.rideLocations.length / this.mechanics.length);
            for (var i = 0; i < this.mechanics.length; i++) {
                var mechanic = this.mechanics[i];
                if (!mechanic || typeof mechanic.id !== 'number') continue;
                var startRide = i * ridesPerMechanic;
                var endRide = Math.min(startRide + ridesPerMechanic, ParkAnalyzer.rideLocations.length);
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (var j = startRide; j < endRide; j++) {
                    var ride = ParkAnalyzer.rideLocations[j];
                    if (ride) {
                        minX = Math.min(minX, ride.x);
                        minY = Math.min(minY, ride.y);
                        maxX = Math.max(maxX, ride.x);
                        maxY = Math.max(maxY, ride.y);
                    }
                }
                if (minX !== Infinity) {
                    this.setStaffPatrolArea(mechanic.id, 
                        Math.max(0, minX - 5), Math.max(0, minY - 5),
                        Math.min(mapWidth - 1, maxX + 5), Math.min(mapHeight - 1, maxY + 5), 0);
                }
            }
        },

        generateSecurityPatrolZones: function() {
            if (this.security.length === 0) return;
            var mapWidth = 128, mapHeight = 128;
            try { mapWidth = map.size.x; mapHeight = map.size.y; } catch (e) {}

            var hotspots = ParkAnalyzer.getGuestHotspots(this.security.length);
            for (var i = 0; i < this.security.length; i++) {
                var guard = this.security[i];
                if (!guard || typeof guard.id !== 'number') continue;
                var centerX, centerY;
                if (hotspots[i]) {
                    centerX = hotspots[i].x;
                    centerY = hotspots[i].y;
                } else if (ParkAnalyzer.entranceLocations.length > 0) {
                    var entrance = ParkAnalyzer.entranceLocations[i % ParkAnalyzer.entranceLocations.length];
                    centerX = entrance.x;
                    centerY = entrance.y;
                } else {
                    var zoneSize = CONFIG.patrolZoneSize * 2;
                    var zonesX = Math.ceil(mapWidth / zoneSize);
                    var zoneIndex = i % (zonesX * Math.ceil(mapHeight / zoneSize));
                    centerX = (zoneIndex % zonesX) * zoneSize + zoneSize / 2;
                    centerY = Math.floor(zoneIndex / zonesX) * zoneSize + zoneSize / 2;
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

            var lowAreas = this.getLowHappinessAreas();
            var guestHotspots = ParkAnalyzer.getGuestHotspots(this.entertainers.length);
            var targets = lowAreas.length > 0 ? lowAreas : guestHotspots;

            for (var i = 0; i < this.entertainers.length; i++) {
                var entertainer = this.entertainers[i];
                if (!entertainer || typeof entertainer.id !== 'number') continue;
                var target;
                if (targets.length > 0) {
                    target = targets[i % targets.length];
                } else if (ParkAnalyzer.entranceLocations.length > 0) {
                    target = ParkAnalyzer.entranceLocations[i % ParkAnalyzer.entranceLocations.length];
                } else {
                    var zoneSize = CONFIG.patrolZoneSize * 2;
                    var zonesX = Math.ceil(mapWidth / zoneSize);
                    var zoneIndex = i % (zonesX * Math.ceil(mapHeight / zoneSize));
                    target = {
                        x: (zoneIndex % zonesX) * zoneSize + zoneSize / 2,
                        y: Math.floor(zoneIndex / zonesX) * zoneSize + zoneSize / 2
                    };
                }
                var radius = CONFIG.patrolZoneSize;
                this.setStaffPatrolArea(entertainer.id,
                    Math.max(0, target.x - radius), Math.max(0, target.y - radius),
                    Math.min(mapWidth - 1, target.x + radius), Math.min(mapHeight - 1, target.y + radius), 0);
            }
        },

        processHandymen: function() {
            if (!CONFIG.handymanEnabled) return;
            if (this.handymen.length === 0) return;
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
                    this.setStaffOrders(handyman.id, orders);
                }
            }
            
            // NOTE: Removed direct destination assignment - this caused desync!
            // Staff will naturally move within their patrol zones
        },

        processMechanics: function() {
            if (!CONFIG.mechanicEnabled) return;
            if (this.mechanics.length === 0) return;
            // NOTE: Removed direct destination assignment - causes desync
            // Mechanics handle breakdowns automatically within patrol zones
        },

        processSecurity: function() {
            if (!CONFIG.securityEnabled) return;
            if (this.security.length === 0) return;
            // NOTE: Removed direct destination assignment - causes desync
        },

        processEntertainers: function() {
            if (!CONFIG.entertainerEnabled) return;
            if (this.entertainers.length === 0) return;
            // NOTE: Removed direct destination assignment - causes desync
        },

        onTick: function() {
            if (!CONFIG.enabled) return;
            
            // Use game ticks for consistency
            var gameTick = this.getGameTick();
            this.tickCounter = gameTick;

            // Process action queue
            ActionQueue.process();

            if (!ParkAnalyzer.isAnalyzed) {
                ParkAnalyzer.runAnalysisStep();
                return;
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
                this.processMechanics();
                this.processSecurity();
                this.processEntertainers();
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
    // UI MANAGER (Client-safe - no game state changes)
    // ============================================================
    var UIManager = {
        mainWindow: null,
        windowId: 'staff-ai-mgr',
        updateInterval: null,
        currentTab: 0,

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
                    var widgets = ['chk_handyman_autohire', 'chk_mechanic_autohire', 
                                   'chk_security_autohire', 'chk_entertainer_autohire'];
                    for (var i = 0; i < widgets.length; i++) {
                        var w = this.mainWindow.findWidget(widgets[i]);
                        if (w) w.isChecked = checked;
                    }
                } catch (e) {}
            }
        },

        toggleWindow: function() {
            var existingWindow = ui.getWindow(this.windowId);
            if (existingWindow) {
                existingWindow.close();
            } else {
                this.openWindow();
            }
        },

        openWindow: function() {
            var existingWindow = ui.getWindow(this.windowId);
            if (existingWindow) {
                existingWindow.bringToFront();
                return;
            }
            this.disposeUpdateInterval();
            var self = this;
            var windowWidth = 450;
            var windowHeight = 380;
            var contentY = 40;

            var allWidgets = [
                {type:'button',name:'btn_tab_0',x:10,y:20,width:70,height:14,text:'Overview',isPressed:true,onClick:function(){self.switchTab(0);}},
                {type:'button',name:'btn_tab_1',x:82,y:20,width:70,height:14,text:'Handymen',onClick:function(){self.switchTab(1);}},
                {type:'button',name:'btn_tab_2',x:154,y:20,width:70,height:14,text:'Mechanics',onClick:function(){self.switchTab(2);}},
                {type:'button',name:'btn_tab_3',x:226,y:20,width:70,height:14,text:'Security',onClick:function(){self.switchTab(3);}},
                {type:'button',name:'btn_tab_4',x:298,y:20,width:80,height:14,text:'Entertainers',onClick:function(){self.switchTab(4);}},
                {type:'button',name:'btn_tab_5',x:380,y:20,width:60,height:14,text:'Stats',onClick:function(){self.switchTab(5);}},
                
                // Overview Tab
                {type:'groupbox',name:'grp_overview_1',x:10,y:contentY,width:430,height:70,text:'System Status',isVisible:true},
                {type:'label',name:'lbl_network_mode',x:18,y:contentY+14,width:200,height:14,text:'Mode: '+NetworkHelper.getModeString(),isVisible:true},
                {type:'label',name:'lbl_permissions',x:228,y:contentY+14,width:200,height:14,text:'Can Modify: '+(NetworkHelper.canModifyGameState()?'Yes':'No'),isVisible:true},
                {type:'label',name:'lbl_analysis',x:18,y:contentY+28,width:200,height:14,text:'Analysis: Pending',isVisible:true},
                {type:'label',name:'lbl_frame',x:228,y:contentY+28,width:200,height:14,text:'Frame: 0ms',isVisible:true},
                {type:'label',name:'lbl_tick',x:18,y:contentY+42,width:200,height:14,text:'Tick: 0',isVisible:true},
                {type:'label',name:'lbl_zones_status',x:228,y:contentY+42,width:200,height:14,text:'Zones: 0 set',isVisible:true},
                
                {type:'groupbox',name:'grp_overview_2',x:10,y:contentY+75,width:430,height:55,text:'Staff Counts',isVisible:true},
                {type:'label',name:'lbl_total_staff',x:18,y:contentY+89,width:100,height:14,text:'Total: 0',isVisible:true},
                {type:'label',name:'lbl_handymen',x:118,y:contentY+89,width:100,height:14,text:'Handymen: 0',isVisible:true},
                {type:'label',name:'lbl_mechanics',x:228,y:contentY+89,width:100,height:14,text:'Mechanics: 0',isVisible:true},
                {type:'label',name:'lbl_security',x:338,y:contentY+89,width:100,height:14,text:'Security: 0',isVisible:true},
                {type:'label',name:'lbl_entertainers',x:18,y:contentY+103,width:100,height:14,text:'Entertainers: 0',isVisible:true},
                {type:'label',name:'lbl_dispatches',x:118,y:contentY+103,width:100,height:14,text:'Dispatches: 0',isVisible:true},
                {type:'label',name:'lbl_guests',x:228,y:contentY+103,width:100,height:14,text:'Guests: 0',isVisible:true},
                {type:'label',name:'lbl_happiness',x:338,y:contentY+103,width:100,height:14,text:'Happy: 0%',isVisible:true},
                
                {type:'groupbox',name:'grp_overview_3',x:10,y:contentY+135,width:430,height:120,text:'Controls',isVisible:true},
                {type:'checkbox',name:'chk_enabled',x:18,y:contentY+149,width:200,height:14,text:'Enable AI Manager',isChecked:CONFIG.enabled,isVisible:true,onChange:function(c){CONFIG.enabled=c;}},
                {type:'checkbox',name:'chk_debug',x:228,y:contentY+149,width:200,height:14,text:'Debug Mode',isChecked:CONFIG.debugMode,isVisible:true,onChange:function(c){CONFIG.debugMode=c;}},
                {type:'checkbox',name:'chk_autohire',x:18,y:contentY+165,width:200,height:14,text:'Auto-Hire Staff',isChecked:CONFIG.autoHireEnabled,isVisible:true,onChange:function(c){CONFIG.autoHireEnabled=c;self.syncAutoHireCheckboxes(c);}},
                {type:'checkbox',name:'chk_autopatrol',x:228,y:contentY+165,width:200,height:14,text:'Auto Patrol Zones',isChecked:CONFIG.autoPatrolZones,isVisible:true,onChange:function(c){CONFIG.autoPatrolZones=c;}},
                {type:'checkbox',name:'chk_autoreanalyze',x:18,y:contentY+181,width:200,height:14,text:'Auto Re-analyze',isChecked:CONFIG.autoReanalyze,isVisible:true,onChange:function(c){CONFIG.autoReanalyze=c;}},
                {type:'checkbox',name:'chk_autogenzones',x:228,y:contentY+181,width:200,height:14,text:'Auto Gen Zones',isChecked:CONFIG.autoGenZones,isVisible:true,onChange:function(c){CONFIG.autoGenZones=c;}},
                {type:'button',name:'btn_reanalyze',x:18,y:contentY+200,width:130,height:20,text:'Re-analyze Park',isVisible:true,onClick:function(){ParkAnalyzer.startAnalysis();StaffManager.zonesNeedRegeneration=true;}},
                {type:'button',name:'btn_reset',x:158,y:contentY+200,width:130,height:20,text:'Reset Statistics',isVisible:true,onClick:function(){StaffManager.resetStatistics();}},
                {type:'button',name:'btn_genzones',x:298,y:contentY+200,width:130,height:20,text:'Generate Zones',isVisible:true,onClick:function(){StaffManager.zonesNeedRegeneration=true;StaffManager.generatePatrolZones();}},
                {type:'label',name:'lbl_auto_counts',x:18,y:contentY+230,width:400,height:14,text:'Auto: Re-analyze: 0 | GenZones: 0',isVisible:true},
                
                // Handyman Tab
                {type:'groupbox',name:'grp_handyman_1',x:10,y:contentY,width:430,height:100,text:'Handyman Settings',isVisible:false},
                {type:'checkbox',name:'chk_handyman_enabled',x:18,y:contentY+16,width:200,height:14,text:'Enable Handyman AI',isChecked:CONFIG.handymanEnabled,isVisible:false,onChange:function(c){CONFIG.handymanEnabled=c;}},
                {type:'checkbox',name:'chk_handyman_autohire',x:228,y:contentY+16,width:200,height:14,text:'Auto-Hire',isChecked:CONFIG.handymanAutoHire,isVisible:false,onChange:function(c){CONFIG.handymanAutoHire=c;}},
                {type:'checkbox',name:'chk_handyman_sweep',x:18,y:contentY+34,width:100,height:14,text:'Sweep',isChecked:CONFIG.handymanSweepEnabled,isVisible:false,onChange:function(c){CONFIG.handymanSweepEnabled=c;}},
                {type:'checkbox',name:'chk_handyman_water',x:118,y:contentY+34,width:100,height:14,text:'Water',isChecked:CONFIG.handymanWaterEnabled,isVisible:false,onChange:function(c){CONFIG.handymanWaterEnabled=c;}},
                {type:'checkbox',name:'chk_handyman_bins',x:228,y:contentY+34,width:100,height:14,text:'Empty Bins',isChecked:CONFIG.handymanEmptyBinsEnabled,isVisible:false,onChange:function(c){CONFIG.handymanEmptyBinsEnabled=c;}},
                {type:'checkbox',name:'chk_handyman_mow',x:338,y:contentY+34,width:90,height:14,text:'Mow',isChecked:CONFIG.handymanMowEnabled,isVisible:false,onChange:function(c){CONFIG.handymanMowEnabled=c;}},
                {type:'label',name:'lbl_handyman_active',x:18,y:contentY+55,width:200,height:14,text:'Active: 0',isVisible:false},
                {type:'label',name:'lbl_handyman_litter',x:228,y:contentY+55,width:200,height:14,text:'Litter: 0',isVisible:false},
                {type:'button',name:'btn_hire_handyman',x:18,y:contentY+75,width:130,height:20,text:'Hire Handyman',isVisible:false,onClick:function(){StaffManager.hireStaff('handyman');}},
                
                // Mechanic Tab
                {type:'groupbox',name:'grp_mechanic_1',x:10,y:contentY,width:430,height:100,text:'Mechanic Settings',isVisible:false},
                {type:'checkbox',name:'chk_mechanic_enabled',x:18,y:contentY+16,width:200,height:14,text:'Enable Mechanic AI',isChecked:CONFIG.mechanicEnabled,isVisible:false,onChange:function(c){CONFIG.mechanicEnabled=c;}},
                {type:'checkbox',name:'chk_mechanic_autohire',x:228,y:contentY+16,width:200,height:14,text:'Auto-Hire',isChecked:CONFIG.mechanicAutoHire,isVisible:false,onChange:function(c){CONFIG.mechanicAutoHire=c;}},
                {type:'checkbox',name:'chk_mechanic_preventive',x:18,y:contentY+34,width:200,height:14,text:'Preventive Maintenance',isChecked:CONFIG.mechanicPreventiveEnabled,isVisible:false,onChange:function(c){CONFIG.mechanicPreventiveEnabled=c;}},
                {type:'label',name:'lbl_mechanic_active',x:18,y:contentY+55,width:200,height:14,text:'Active: 0',isVisible:false},
                {type:'label',name:'lbl_mechanic_fixed',x:228,y:contentY+55,width:200,height:14,text:'Rides Fixed: 0',isVisible:false},
                {type:'button',name:'btn_hire_mechanic',x:18,y:contentY+75,width:130,height:20,text:'Hire Mechanic',isVisible:false,onClick:function(){StaffManager.hireStaff('mechanic');}},
                
                // Security Tab
                {type:'groupbox',name:'grp_security_1',x:10,y:contentY,width:430,height:100,text:'Security Settings',isVisible:false},
                {type:'checkbox',name:'chk_security_enabled',x:18,y:contentY+16,width:200,height:14,text:'Enable Security AI',isChecked:CONFIG.securityEnabled,isVisible:false,onChange:function(c){CONFIG.securityEnabled=c;}},
                {type:'checkbox',name:'chk_security_autohire',x:228,y:contentY+16,width:200,height:14,text:'Auto-Hire',isChecked:CONFIG.securityAutoHire,isVisible:false,onChange:function(c){CONFIG.securityAutoHire=c;}},
                {type:'label',name:'lbl_security_active',x:18,y:contentY+55,width:200,height:14,text:'Active: 0',isVisible:false},
                {type:'button',name:'btn_hire_security',x:18,y:contentY+75,width:130,height:20,text:'Hire Security',isVisible:false,onClick:function(){StaffManager.hireStaff('security');}},
                
                // Entertainer Tab
                {type:'groupbox',name:'grp_entertainer_1',x:10,y:contentY,width:430,height:100,text:'Entertainer Settings',isVisible:false},
                {type:'checkbox',name:'chk_entertainer_enabled',x:18,y:contentY+16,width:200,height:14,text:'Enable Entertainer AI',isChecked:CONFIG.entertainerEnabled,isVisible:false,onChange:function(c){CONFIG.entertainerEnabled=c;}},
                {type:'checkbox',name:'chk_entertainer_autohire',x:228,y:contentY+16,width:200,height:14,text:'Auto-Hire',isChecked:CONFIG.entertainerAutoHire,isVisible:false,onChange:function(c){CONFIG.entertainerAutoHire=c;}},
                {type:'label',name:'lbl_entertainer_active',x:18,y:contentY+55,width:200,height:14,text:'Active: 0',isVisible:false},
                {type:'button',name:'btn_hire_entertainer',x:18,y:contentY+75,width:130,height:20,text:'Hire Entertainer',isVisible:false,onClick:function(){StaffManager.hireStaff('entertainer');}},
                
                // Stats Tab
                {type:'groupbox',name:'grp_stats_1',x:10,y:contentY,width:430,height:180,text:'Statistics',isVisible:false},
                {type:'label',name:'lbl_stat_hired',x:18,y:contentY+16,width:200,height:14,text:'Staff Hired: 0',isVisible:false},
                {type:'label',name:'lbl_stat_orders',x:228,y:contentY+16,width:200,height:14,text:'Orders Changed: 0',isVisible:false},
                {type:'label',name:'lbl_stat_patrols',x:18,y:contentY+32,width:200,height:14,text:'Patrol Zones Set: 0',isVisible:false},
                {type:'label',name:'lbl_stat_failed',x:228,y:contentY+32,width:200,height:14,text:'Zones Failed: 0',isVisible:false},
                {type:'label',name:'lbl_stat_dispatches',x:18,y:contentY+48,width:200,height:14,text:'Dispatches: 0',isVisible:false},
                {type:'label',name:'lbl_stat_litter',x:228,y:contentY+48,width:200,height:14,text:'Total Litter: 0',isVisible:false},
                {type:'label',name:'lbl_stat_frame',x:18,y:contentY+80,width:200,height:14,text:'Frame Time: 0ms',isVisible:false},
                {type:'label',name:'lbl_stat_avgframe',x:228,y:contentY+80,width:200,height:14,text:'Avg Frame: 0ms',isVisible:false},
                {type:'label',name:'lbl_stat_autore',x:18,y:contentY+96,width:200,height:14,text:'Auto Re-analyze: 0',isVisible:false},
                {type:'label',name:'lbl_stat_autozone',x:228,y:contentY+96,width:200,height:14,text:'Auto Gen Zones: 0',isVisible:false},
                {type:'label',name:'lbl_stat_paths',x:18,y:contentY+128,width:200,height:14,text:'Path Tiles: 0',isVisible:false},
                {type:'label',name:'lbl_stat_rides',x:228,y:contentY+128,width:200,height:14,text:'Ride Locations: 0',isVisible:false}
            ];

            this.mainWindow = ui.openWindow({
                classification: this.windowId,
                title: 'Staff AI Manager v2.2.1 (MP Sync Fixed)',
                x: Math.floor((ui.width - windowWidth) / 2),
                y: Math.floor((ui.height - windowHeight) / 2),
                width: windowWidth,
                height: windowHeight,
                colours: [24, 24],
                widgets: allWidgets,
                onClose: function() {
                    self.mainWindow = null;
                    self.disposeUpdateInterval();
                }
            });

            this.currentTab = 0;
            this.updateInterval = context.setInterval(function() {
                self.updateDisplay();
            }, 500);
        },

        switchTab: function(tabIndex) {
            if (!this.mainWindow) return;
            this.currentTab = tabIndex;
            
            for (var t = 0; t < 6; t++) {
                var btn = this.mainWindow.findWidget('btn_tab_' + t);
                if (btn) btn.isPressed = (t === tabIndex);
            }

            var tabWidgets = {
                0: ['grp_overview_1','grp_overview_2','grp_overview_3','lbl_network_mode','lbl_permissions','lbl_analysis','lbl_frame','lbl_tick','lbl_zones_status','lbl_total_staff','lbl_handymen','lbl_mechanics','lbl_security','lbl_entertainers','lbl_dispatches','lbl_guests','lbl_happiness','chk_enabled','chk_debug','chk_autohire','chk_autopatrol','chk_autoreanalyze','chk_autogenzones','btn_reanalyze','btn_reset','btn_genzones','lbl_auto_counts'],
                1: ['grp_handyman_1','chk_handyman_enabled','chk_handyman_autohire','chk_handyman_sweep','chk_handyman_water','chk_handyman_bins','chk_handyman_mow','lbl_handyman_active','lbl_handyman_litter','btn_hire_handyman'],
                2: ['grp_mechanic_1','chk_mechanic_enabled','chk_mechanic_autohire','chk_mechanic_preventive','lbl_mechanic_active','lbl_mechanic_fixed','btn_hire_mechanic'],
                3: ['grp_security_1','chk_security_enabled','chk_security_autohire','lbl_security_active','btn_hire_security'],
                4: ['grp_entertainer_1','chk_entertainer_enabled','chk_entertainer_autohire','lbl_entertainer_active','btn_hire_entertainer'],
                5: ['grp_stats_1','lbl_stat_hired','lbl_stat_orders','lbl_stat_patrols','lbl_stat_failed','lbl_stat_dispatches','lbl_stat_litter','lbl_stat_frame','lbl_stat_avgframe','lbl_stat_autore','lbl_stat_autozone','lbl_stat_paths','lbl_stat_rides']
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

            this.updateLabel('lbl_network_mode', 'Mode: ' + NetworkHelper.getModeString());
            this.updateLabel('lbl_permissions', 'Can Modify: ' + (NetworkHelper.canModifyGameState() ? 'Yes' : 'No'));
            var analysisStatus = ParkAnalyzer.isAnalyzed ? 'Complete (' + ParkAnalyzer.totalPathTiles + ' paths)' : 'Progress: ' + ParkAnalyzer.getProgress() + '%';
            this.updateLabel('lbl_analysis', 'Analysis: ' + analysisStatus);
            this.updateLabel('lbl_frame', 'Frame: ' + s.lastFrameTime.toFixed(1) + 'ms');
            this.updateLabel('lbl_tick', 'Tick: ' + StaffManager.tickCounter);
            this.updateLabel('lbl_zones_status', 'Zones: ' + s.patrolZonesSet + ' set');
            this.updateLabel('lbl_total_staff', 'Total: ' + s.totalStaff);
            this.updateLabel('lbl_handymen', 'Handymen: ' + s.handymenCount);
            this.updateLabel('lbl_mechanics', 'Mechanics: ' + s.mechanicsCount);
            this.updateLabel('lbl_security', 'Security: ' + s.securityCount);
            this.updateLabel('lbl_entertainers', 'Entertainers: ' + s.entertainersCount);
            this.updateLabel('lbl_dispatches', 'Dispatches: ' + s.dispatchesMade);
            this.updateLabel('lbl_guests', 'Guests: ' + ParkAnalyzer.totalGuests);
            this.updateLabel('lbl_happiness', 'Happy: ' + Math.round(ParkAnalyzer.averageGuestHappiness / 2.55) + '%');
            this.updateLabel('lbl_auto_counts', 'Auto: Re-analyze: ' + s.autoReanalyzeCount + ' | GenZones: ' + s.autoGenZonesCount);
            this.updateLabel('lbl_handyman_active', 'Active: ' + s.handymenCount);
            this.updateLabel('lbl_handyman_litter', 'Litter: ' + ParkAnalyzer.totalLitter);
            this.updateLabel('lbl_mechanic_active', 'Active: ' + s.mechanicsCount);
            this.updateLabel('lbl_mechanic_fixed', 'Rides Fixed: ' + s.ridesFixed);
            this.updateLabel('lbl_security_active', 'Active: ' + s.securityCount);
            this.updateLabel('lbl_entertainer_active', 'Active: ' + s.entertainersCount);
            this.updateLabel('lbl_stat_hired', 'Staff Hired: ' + s.staffHired);
            this.updateLabel('lbl_stat_orders', 'Orders Changed: ' + s.ordersChanged);
            this.updateLabel('lbl_stat_patrols', 'Patrol Zones Set: ' + s.patrolZonesSet);
            this.updateLabel('lbl_stat_failed', 'Zones Failed: ' + s.patrolZonesFailed);
            this.updateLabel('lbl_stat_dispatches', 'Dispatches: ' + s.dispatchesMade);
            this.updateLabel('lbl_stat_litter', 'Total Litter: ' + ParkAnalyzer.totalLitter);
            this.updateLabel('lbl_stat_frame', 'Frame Time: ' + s.lastFrameTime.toFixed(2) + 'ms');
            this.updateLabel('lbl_stat_avgframe', 'Avg Frame: ' + s.avgFrameTime.toFixed(2) + 'ms');
            this.updateLabel('lbl_stat_autore', 'Auto Re-analyze: ' + s.autoReanalyzeCount);
            this.updateLabel('lbl_stat_autozone', 'Auto Gen Zones: ' + s.autoGenZonesCount);
            this.updateLabel('lbl_stat_paths', 'Path Tiles: ' + ParkAnalyzer.totalPathTiles);
            this.updateLabel('lbl_stat_rides', 'Ride Locations: ' + ParkAnalyzer.rideLocations.length);
        }
    };

    // ============================================================
    // MAIN ENTRY POINT
    // ============================================================
    function main() {
        StaffManager.initialize();

        if (typeof ui !== 'undefined') {
            ui.registerMenuItem('Staff AI Manager', function() {
                UIManager.toggleWindow();
            });
        }

        context.subscribe('interval.tick', function() {
            try {
                StaffManager.onTick();
            } catch (e) {
                if (CONFIG.debugMode) {
                    console.log('[Staff AI Manager] Error in onTick: ' + e);
                }
            }
        });

        context.subscribe('map.change', function() {
            ParkAnalyzer.startAnalysis();
            StaffManager.staffAssignments = {};
            StaffManager.staffPerformance = {};
            StaffManager.zonesNeedRegeneration = true;
        });

        var modeStr = NetworkHelper.getModeString();
        console.log('[Staff AI Manager v2.2.1] Loaded - Multiplayer Desync Fixed!');
        console.log('[Staff AI Manager v2.2.1] Network mode: ' + modeStr);
        
        if (NetworkHelper.canModifyGameState()) {
            console.log('[Staff AI Manager v2.2.1] Full control - staff management active');
        } else {
            console.log('[Staff AI Manager v2.2.1] Client mode - view only');
        }
    }

    registerPlugin({
        name: 'Staff AI Manager',
        version: '2.2.0',
        authors: ['CodingFleet'],
        type: 'remote',
        licence: 'MIT',
        targetApiVersion: 77,
        minApiVersion: 34,
        main: main
    });
})();
