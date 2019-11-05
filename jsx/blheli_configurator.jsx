'use strict';

const METAINFO_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

// Fix for nw.js which has regeneratorRuntime defined in global.
if (window.regeneratorRuntime == undefined) {
    window.regeneratorRuntime = global.regeneratorRuntime;
}

var Configurator = React.createClass({
    getInitialState: () => {
        return {
            canRead: true,
            canWrite: false,
            canFlash: false,
            canFlashTlm: false,
            isFlashing: false,
            isLicensed: true,
            selectingFirmware: false,
            licensingAll: false,
            hasTelemetry: false,
            isActivated: false,
            noteStyle: "note",
            noteText: "escFeaturesHelp",
            escSettings: [],
            escMetainfo: [],

            ignoreMCULayout: false,

            flashingEscIndex: undefined,
            flashingEscProgress: 0
        };
    },
    componentWillMount: function() {
        this.updateVersionsMetainfo();
        const interval = setInterval(this.updateVersionsMetainfo, METAINFO_UPDATE_INTERVAL_MS);

        this.setState({
            updateInterval: interval
        });
    },
    componentWillUnmount: function() {
        if (this.state.updateInterval) {
            clearInterval(this.state.updateInterval);
        }
    },
    updateVersionsMetainfo: function() {
        fetchJSON(BLHELI_ESCS_KEY, BLHELI_ESCS_REMOTE, BLHELI_ESCS_LOCAL)
        .then(json => this.setState({ supportedESCs: json }));

        fetchJSON(BLHELI_VERSIONS_KEY, BLHELI_VERSIONS_REMOTE, BLHELI_VERSIONS_LOCAL)
        .then(json => this.setState({ firmwareVersions: json }));
    },
    onUserInput: function(newSettings) {
        this.setState({
            escSettings: newSettings
        });
    },
    saveLog: () => saveFile(console.dump().join('\n')),
    licenseAll: async function() {
        this.setState({licensingAll: true});
    },
    readSetup: async function() {
        GUI.log(chrome.i18n.getMessage('readSetupStarted'));
        
        var version = await(_4way.getProtocolVersion());
        GUI.log("Protocol Version: " + version);
        if (version < 108) {
            GUI.log("Please install the BetaFlight firmware mentioned in the instructions first!");
            return;
        }
        $('a.connect').addClass('disabled');

        // disallow further requests until we're finished
        // @todo also disable settings alteration
        this.setState({
            canRead: false,
            canWrite: false,
            canFlash: false,
            canFlashTlm: false
        });

        try {
            await this.readSetupAll();
            GUI.log(chrome.i18n.getMessage('readSetupFinished'));
        } catch (error) {
            GUI.log(chrome.i18n.getMessage('readSetupFailed', [ error.stack ]));
        }

        // Enable `Flash All` if all ESCs are identical
        const availableSettings = this.state.escSettings.filter((i, idx) => this.state.escMetainfo[idx].available);
        // @todo remove when Atmel flashing has been checked
        const availableMetainfos = this.state.escMetainfo.filter(info => info.available);
        var isLicensed = true;
        var isActivated = true;
        var isJesc = true;
        var hasTelemetry = true;
        for (var i = 0; i < this.props.escCount; i++) {
            if (!this.state.escMetainfo[i].isLicensed) {
                isLicensed = false;
            }
            if (!this.state.escMetainfo[i].isActivated) {
                isActivated = false;
            }
            if (!this.state.escMetainfo[i].isJesc) {
                isJesc = false;
            }
            if (this.state.escMetainfo[i].tlmVersion == 0) {
                hasTelemetry = false;
            }
        }
        const canFlash = availableSettings.every(settings => settings.LAYOUT === availableSettings[0].LAYOUT);
        const canResetDefaults = availableSettings.every(settings => settings.LAYOUT_REVISION > BLHELI_S_MIN_LAYOUT_REVISION);
        var noteStyle = "note";
        var noteText = "escFeaturesHelp";
        if (this.props.escCount && !isLicensed) {
            noteStyle = "info";
            noteText = "escFeaturesHelpUnlicensed";
        } else if (isLicensed && !hasTelemetry) {
            noteStyle = "alert";
            if (!isActivated) {
                noteText = "escWarnJESC";
            } else {
                noteText = "escWarnTelemetry";
            }
        }

        this.setState({
            canRead: true,
            canWrite: availableSettings.length > 0,
            canFlash: availableSettings.length > 0 && canFlash,
            canFlashTlm: availableSettings.length > 0 && canFlash && isJesc && isLicensed && isActivated,
            canResetDefaults: canResetDefaults,
            hasTelemetry: hasTelemetry,
            isLicensed: availableSettings.length == 0 || isLicensed,
            isActivated: isActivated,
            noteStyle: noteStyle,
            noteText: noteText
        });

        $('a.connect').removeClass('disabled');
    },
    readSetupAll: async function() {
        var escSettings = [],
            escMetainfo = [];

        if (Debug.enabled) {
            escSettings = [ Debug.getDummySettings(BLHELI_TYPES.BLHELI_S_SILABS) ];
            escMetainfo = [ Debug.getDummyMetainfo(BLHELI_TYPES.BLHELI_S_SILABS) ];

            this.setState({
                escSettings: escSettings,
                escMetainfo: escMetainfo
            });

            return;
        }

        var uidQuery = 'https://jflight.net/checkuids.php?';
        var uidCount = 1;
        for (let esc = 0; esc < this.props.escCount; ++esc) {
            escSettings.push({});
            escMetainfo.push({});

            try {
                // Ask 4way interface to initialize target ESC for flashing
                const message = await _4way.initFlash(esc);

                // Check interface mode and read settings
                const interfaceMode = message.params[3]

                // remember interface mode for ESC
                escMetainfo[esc].interfaceMode = interfaceMode
                // @todo C2 will require redesign here
                escMetainfo[esc].signature = (message.params[1] << 8) | message.params[0];

                // read everything in one big chunk
                // SiLabs has no separate EEPROM, but Atmel has and therefore requires a different read command
                var isSiLabs = [ _4way_modes.SiLC2, _4way_modes.SiLBLB ].includes(interfaceMode),
                    settingsArray = null;

                escMetainfo[esc].isActivated = false;
                escMetainfo[esc].tlmVersion = undefined;
                escMetainfo[esc].isJesc = false;

                if (isSiLabs) {
                    const data3 = (await _4way.read(0xb0, 0x4)).params;
                    escMetainfo[esc].isJesc = buf2ascii(data3.subarray(0,4)) == 'JESC';
                    const data = (await _4way.read(0xfbfc, 3)).params;
                    if (data[0] != 0 && data[1] == 0xa5 && data[2] == 0xa5)
                        escMetainfo[esc].isActivated = true;
                    const data2 = (await _4way.read(0x3e00, 5)).params;
                    escMetainfo[esc].tlmVersion = 0;
                    if (buf2ascii(data2.subarray(0,3)) == 'TLX') {
                        escMetainfo[esc].tlmVersion = data2[3] + '.' + data2[4];
                    }
                    
                    settingsArray = (await _4way.read(BLHELI_SILABS_EEPROM_OFFSET, BLHELI_LAYOUT_SIZE)).params;
                    var uidHex = '';
                    const uid = (await _4way.read(0xffc0, 16)).params;
                    uid.forEach((elem) => { var h = '0' + elem.toString(16); uidHex += h.slice(h.length - 2, h.length)});
                    GUI.log('uid: ' + uidHex);
                    escMetainfo[esc].uid = uidHex;
                    uidQuery += 'uid' + uidCount++ + '=' + uidHex + '&';

                } else {
                    settingsArray = (await _4way.readEEprom(0, BLHELI_LAYOUT_SIZE)).params;
                }

                const settings = blheliSettingsObject(settingsArray);

                escSettings[esc] = settings;
                escMetainfo[esc].available = true;

                googleAnalytics.sendEvent('ESC', 'VERSION', settings.MAIN_REVISION + '.' + settings.SUB_REVISION);
                googleAnalytics.sendEvent('ESC', 'LAYOUT', settings.LAYOUT.replace(/#/g, ''));
                googleAnalytics.sendEvent('ESC', 'MODE', blheliModeToString(settings.MODE));
                googleAnalytics.sendEvent('ESC', 'COMMUTATION_TIMING', settings.COMMUTATION_TIMING);
                googleAnalytics.sendEvent('ESC', 'DEMAG_COMPENSATION', settings.DEMAG_COMPENSATION);
                googleAnalytics.sendEvent('ESC', 'STARTUP_POWER', settings.STARTUP_POWER);
                googleAnalytics.sendEvent('ESC', 'PPM_MIN_THROTTLE', settings.PPM_MIN_THROTTLE);
                googleAnalytics.sendEvent('ESC', 'PPM_MAX_THROTTLE', settings.PPM_MAX_THROTTLE);

                if (isSiLabs) {
                    await _4way.reset(esc);
                }
            } catch (error) {
                console.log('ESC', esc + 1, 'read settings failed', error.message);
                escMetainfo[esc].available = false;
            }
        }
         
        try {
            var deferred = Q.defer();
            $.get(uidQuery, function (content) {
                return deferred.resolve(content);
            }).fail(function () {
                GUI.log("couldn't retrieve esc status due to internet availability");
                return deferred.reject(new Error('File is unavailable'));
            })
            ;
            var result = JSON.parse(await deferred.promise);
            
            for (let esc = 0; esc < this.props.escCount; ++esc) {
                escMetainfo[esc].isLicensed = result[esc] != 0;
            };
            
        } catch(error) {
            console.log('read license status failed', error.message);
        }


        
        // Update backend and trigger representation
        this.setState({
            escSettings: escSettings,
            escMetainfo: escMetainfo
        });
    },
    // @todo add validation of each setting via BLHELI_SETTINGS_DESCRIPTION
    writeSetupAll: async function() {
        for (var esc = 0; esc < this.state.escSettings.length; ++esc) {
            await this.writeSetupImpl(esc);
        }
    },
    writeSetupImpl: async function(esc) {
        try {
            if (!this.state.escMetainfo[esc].available) {
               return;
            }

            // Ask 4way interface to initialize target ESC for flashing
            const message = await _4way.initFlash(esc);
            // Remember interface mode and read settings
            var interfaceMode = message.params[3]

            // read everything in one big chunk to check if any settings have changed
            // SiLabs has no separate EEPROM, but Atmel has and therefore requires a different read command
            var isSiLabs = [ _4way_modes.SiLC2, _4way_modes.SiLBLB ].includes(interfaceMode),
                readbackSettings = null;

            if (isSiLabs) {
                readbackSettings = (await _4way.read(BLHELI_SILABS_EEPROM_OFFSET, BLHELI_LAYOUT_SIZE)).params;
            } else {
                readbackSettings = (await _4way.readEEprom(0, BLHELI_LAYOUT_SIZE)).params;
            }

            // Check for changes and perform write
            var escSettings = blheliSettingsArray(this.state.escSettings[esc]);

            // check for unexpected size mismatch
            if (escSettings.byteLength != readbackSettings.byteLength) {
                throw new Error('byteLength of buffers do not match')
            }

            // check for actual changes, maybe we should not write to this ESC at all
            if (compare(escSettings, readbackSettings)) {
                GUI.log(chrome.i18n.getMessage('writeSetupNoChanges', [ esc + 1 ]));
                return;
            }

            // should erase page to 0xFF on SiLabs before writing
            if (isSiLabs) {
                await _4way.pageErase(BLHELI_SILABS_EEPROM_OFFSET / BLHELI_SILABS_PAGE_SIZE);
                // actual write
                await _4way.write(BLHELI_SILABS_EEPROM_OFFSET, escSettings);
                GUI.log(chrome.i18n.getMessage('writeSetupBytesWritten', [ esc + 1, escSettings.byteLength ]));
            } else {
                // write only changed bytes for Atmel
                for (var pos = 0; pos < escSettings.byteLength; ++pos) {
                    var offset = pos

                    // find the longest span of modified bytes
                    while (escSettings[pos] != readbackSettings[pos]) {
                        ++pos
                    }

                    // byte unchanged, continue
                    if (offset == pos) {
                        continue
                    }

                    // write span
                    await _4way.writeEEprom(offset, escSettings.subarray(offset, pos));
                    GUI.log(chrome.i18n.getMessage('writeSetupBytesWritten', [ esc + 1, pos - offset ]));
                }
            }

            if (isSiLabs) {
                readbackSettings = (await _4way.read(BLHELI_SILABS_EEPROM_OFFSET, BLHELI_LAYOUT_SIZE)).params;
            } else {
                readbackSettings = (await _4way.readEEprom(0, BLHELI_LAYOUT_SIZE)).params;
            }

            if (!compare(escSettings, readbackSettings)) {
                throw new Error('Failed to verify settings')
            }

            if (isSiLabs) {
                await _4way.reset(esc);
            }
        } catch (error) {
            GUI.log(chrome.i18n.getMessage('writeSetupFailedOne', [ esc + 1, error.message ]));
        }
    },
    writeSetup: async function() {
        GUI.log(chrome.i18n.getMessage('writeSetupStarted'));
        $('a.connect').addClass('disabled');

        // disallow further requests until we're finished
        // @todo also disable settings alteration
        this.setState({
            canRead: false,
            canWrite: false,
            canFlash: false,
            canFlashTlm: false,
            isLicensed: true
        });

        try {
            await this.writeSetupAll();
            GUI.log(chrome.i18n.getMessage('writeSetupFinished'));
        } catch (error) {
            GUI.log(chrome.i18n.getMessage('writeSetupFailed', [ error.stack ]));
        }

        await this.readSetup();

        $('a.connect').removeClass('disabled');
    },
    resetDefaults: function() {
        var newSettings = [];

        this.state.escSettings.forEach((settings, index) => {
            if (!this.state.escMetainfo[index].available) {
                newSettings.push({})
                return;
            }

            const defaults = BLHELI_S_DEFAULTS[settings.LAYOUT_REVISION];
            if (defaults) {
                for (var settingName in defaults) {
                    if (defaults.hasOwnProperty(settingName)) {
                        settings[settingName] = defaults[settingName];
                    }
                }
            }

            newSettings.push(settings);
        })

        this.setState({
            escSettings: newSettings
        });

        this.writeSetup()
        .catch(error => console.log("Unexpected error while writing default setup", error))
    },
    flashOne: async function(escIndex, selectJESC) {
        this.setState({
            selectingFirmware: true,
            escsToFlash: [ escIndex ],
            selectJESC: selectJESC
        });
    },
    flashFirmwareImpl: async function(escIndex, escSettings, escMetainfo, flashImage, eepromImage, notifyProgress, restart, status) {
        var isAtmel = [ _4way_modes.AtmBLB, _4way_modes.AtmSK ].includes(escMetainfo.interfaceMode),
            self = this;

        // start the actual flashing process
        const initFlashResponse = await _4way.initFlash(escIndex);
        // select flashing algorithm given interface mode
        await selectInterfaceAndFlash(initFlashResponse, escIndex, restart);


        await _4way.initFlash(escIndex);
        await _4way.read(0x1000, 0x10);
        await _4way.read(0x1400, 0x10);
        await _4way.read(0xfbf0, 0x10);
        var settingsArray;
        if (isAtmel) {
            settingsArray = (await _4way.readEEprom(0, BLHELI_LAYOUT_SIZE)).params;
        } else {
            settingsArray = (await _4way.read(BLHELI_SILABS_EEPROM_OFFSET, BLHELI_LAYOUT_SIZE)).params;
        }
        // migrate settings from previous version if asked to
        const newSettings = blheliSettingsObject(settingsArray);

        // ensure mode match
        if (newSettings.MODE === escSettings.MODE) {
            // find intersection between newSettings and escSettings with respect to their versions
            for (var prop in newSettings) {
                if (newSettings.hasOwnProperty(prop) && escSettings.hasOwnProperty(prop) &&
                    blheliCanMigrate(prop, escSettings, newSettings)) {
                    newSettings[prop] = escSettings[prop];                        
                }
            }

            var allSettings = self.state.escSettings.slice();
            allSettings[escIndex] = newSettings;
            self.onUserInput(allSettings);

            GUI.log(chrome.i18n.getMessage('writeSetupStarted'));

            try {
                await self.writeSetupImpl(escIndex);
                GUI.log(chrome.i18n.getMessage('writeSetupFinished'));
            } catch (error) {
                GUI.log(chrome.i18n.getMessage('writeSetupFailed', [ error.message ]));
            }
        } else {
            GUI.log('Will not write settings back due to different MODE\n');

        }

        function updateProgress(bytes) {
            status.bytes_processed += bytes;
            notifyProgress(Math.min(Math.ceil(100 * status.bytes_processed / status.bytes_to_process), 100));
        }

        function selectInterfaceAndFlash(message, escIndex, restart) {
            var interfaceMode = message.params[3]
            escMetainfo.interfaceMode = interfaceMode

            switch (interfaceMode) {
            case _4way_modes.SiLBLB: return flashSiLabsBLB(message, escIndex, restart);
                case _4way_modes.AtmBLB:
                case _4way_modes.AtmSK:  return flashAtmel(message);
                default: throw new Error('Flashing with interface mode ' + interfaceMode + ' is not yet implemented');
            }
        }

        function initialized4Way() {
            _4way.start();
        }

        function rebindMSP(deferred) {
            MSP.send_message(MSP_codes.MSP_SET_4WAY_IF, false, false, function() { return deferred.resolve() });
        }
        
        function flashSiLabsBLB(message, escIndex, restart) {
            // @todo check device id

            
            // read current settings
            var promise = _4way.read(BLHELI_SILABS_EEPROM_OFFSET, BLHELI_LAYOUT_SIZE)
            // check MCU and LAYOUT
            .then(checkESCAndMCU)
            // erase EEPROM page
            .then(erasePage.bind(undefined, 0x0D))
            // write **FLASH*FAILED** as ESC NAME
            .then(writeEEpromSafeguard)
            // write `LJMP bootloader` to avoid bricking            
            .then(writeBootloaderFailsafe)
            // write & verify just erased locations
            .then(writePages.bind(undefined, 0x02, 0x09))
            // write & verify just erased locations
            .then(writePages.bind(undefined, 0x0A, 0x0D))
            .then(writePage.bind(undefined, 0x09))
            // write & verify first page
            .then(writePage.bind(undefined, 0x00))
            // erase second page
            .then(writePage.bind(undefined, 0x01))
            // erase EEPROM
             .then(writePage.bind(undefined, 0x0D));
            if (restart) {
                promise = promise
                .then(_4way.read.bind(_4way, 0x1000, 0x10))
                .then(_4way.read.bind(_4way, 0x1400, 0x10))
                .then(_4way.read.bind(_4way, 0xfbf0, 0x10))
                .then(_4way.reboot.bind(_4way, escIndex))
                .delay(500)
            }
            return promise;
        }

        // @todo
        // 1. add check for ATmega8 vs. ATmega16, they have different flash and eeprom sizes
        function flashAtmel(message) {
            // SimonK uses word instead of byte addressing for flash and address arithmetic on subsequent reads/writes
            const isSimonK = escMetainfo.interfaceMode === _4way_modes.AtmSK
            // @todo check device id

            return _4way.readEEprom(0, BLHELI_LAYOUT_SIZE)
            // check MCU and LAYOUT
            .then(checkESCAndMCU)
            // write **FLASH*FAILED** as NAME
            .then(() => {
                var bytes = ascii2buf('**FLASH*FAILED**')

                return _4way.writeEEprom(BLHELI_LAYOUT.NAME.offset, bytes)
                .then(_4way.readEEprom.bind(_4way, BLHELI_LAYOUT.NAME.offset, BLHELI_LAYOUT.NAME.size))
                .then(message => {
                    if (!compare(bytes, message.params)) {
                        throw new Error('Failed to verify write **FLASH*FAILED**')
                    }
                })
            })
            // write RCALL bootloader_start
            .then(() => {
                var address = isSimonK ? 0x20 : 0x40,
                    // @todo This is a jump to SimonK bootloader, BLHeli bootloader is 512 bytes further, jump could be optimized
                    rcall = new Uint8Array([ 0xDF, 0xCD ]),
                    bytes = new Uint8Array(64).fill(0xFF)

                bytes.set(rcall)

                return _4way.write(address, bytes)
                .then(() => updateProgress(bytes.byteLength))
                .then(_4way.read.bind(_4way, address, rcall.length))
                .then(message => {
                    if (!compare(rcall, message.params)) {
                        throw new Error('Failed to verify `RCALL bootloader` write')
                    }

                    updateProgress(bytes.byteLength);
                })
            })
            // erase first 64 bytes up to RCALL written in the previous step
            .then(() => {
                var bytes = new Uint8Array(64).fill(0xFF)

                return _4way.write(0, bytes)
                .then(() => updateProgress(bytes.byteLength))
                .then(_4way.read.bind(_4way, 0, bytes.byteLength))
                .then(message => {
                    if (!compare(bytes, message.params)) {
                        throw new Error('Failed to verify erasure of first 64 bytes')
                    }
                    updateProgress(bytes.byteLength);
                })
            })
            // write from 0x80 up to bootloader start
            .then(() => {
                var begin_address = 0x80,
                    end_address = (() => {
                        const MCU = findMCU(escMetainfo.signature, self.state.supportedESCs.signatures.Atmel);

                        switch (escMetainfo.interfaceMode) {
                            case _4way_modes.AtmBLB: return MCU.flash_size - BLHELI_ATMEL_BLB_SIZE;
                            case _4way_modes.AtmSK: return MCU.flash_size - BLHELI_ATMEL_SK_SIZE;
                            default: throw Error('unknown interfaceMode ' + escMetainfo.interfaceMode);
                        }
                    })(),
                    write_step = isSimonK ? 0x40 : 0x100,
                    verify_step = 0x80,
                    promise = Q()

                // write
                for (var address = begin_address; address < end_address; address += write_step) {
                    var end = Math.min(address + write_step, end_address),
                        write_address = address;
                    let bytesToWrite = end - address;

                    if (isSimonK) {
                        if (address === begin_address) {
                            write_address /= 2
                        } else {
                            // SimonK bootloader will continue from the last address where we left off
                            write_address = 0xFFFF
                        }
                    }

                    promise = promise
                    .then(_4way.write.bind(_4way, write_address, flashImage.subarray(address, end)))
                    .then(message => {
                        updateProgress(bytesToWrite)
                    })
                }

                // verify
                for (let address = begin_address; address < end_address; address += verify_step) {
                    var bytesToRead = Math.min(address + verify_step, end_address) - address,
                        read_address = address

                    if (isSimonK) {
                        if (address === begin_address) {
                            // Word addressing for flash with SimonK bootloader
                            read_address /= 2
                        } else {
                            // SimonK bootloader will continue from the last address where we left off
                            read_address = 0xFFFF
                        }
                    }

                    promise = promise
                    .then(_4way.read.bind(_4way, read_address, bytesToRead))
                    .then(message => {
                        if (!compare(message.params, flashImage.subarray(address, address + message.params.byteLength))) {
                            throw new Error('Failed to verify write at address 0x' + address.toString(0x10))
                        }

                        updateProgress(message.params.byteLength)
                    })
                }

                return promise
            })
            // write 128 remaining bytes
            .then(() => {
                // @todo combine
                if (isSimonK) {
                    return _4way.write(0, flashImage.subarray(0, 0x40))
                    .then(message => {
                        updateProgress(0x40);
                    })
                    .then(_4way.write.bind(_4way, 0xFFFF, flashImage.subarray(0x40, 0x80)))
                    .then(message => {
                        updateProgress(0x40);
                    })
                    .then(_4way.read.bind(_4way, 0, 0x80))
                    .then(message => {
                        if (!compare(message.params, flashImage.subarray(0, 0x80))) {
                            throw new Error('Failed to verify write at address 0x' + message.address.toString(0x10))
                        }

                        updateProgress(message.params.byteLength)
                    })
                } else {
                    return _4way.write(0, flashImage.subarray(0, 0x80))
                    .then(message => {
                        updateProgress(0x80)
                    })
                    .then(_4way.read.bind(_4way, 0, 0x80))
                    .then(message => {
                        if (!compare(message.params, flashImage.subarray(message.address, message.address + message.params.byteLength))) {
                            throw new Error('Failed to verify write at address 0x' + message.address.toString(0x10))
                        }

                        updateProgress(message.params.byteLength)
                    })
                }
            })
            // write EEprom changes
            .then(() => {
                var eeprom = new Uint8Array(BLHELI_ATMEL_EEPROM_SIZE),
                    beginAddress = 0,
                    endAddress = 0x200,
                    step = 0x80,
                    promise = Q();

                // read whole EEprom
                for (let address = beginAddress; address < endAddress; address += step) {
                    const cmdAddress = address === beginAddress || !isSimonK ? address : 0xFFFF;

                    promise = promise.then(_4way.readEEprom.bind(_4way, cmdAddress, step))
                    .then(message => eeprom.set(message.params, address));
                }

                // write differing bytes
                return promise.then(() => {
                    var promise = Q(),
                        max_bytes_per_write = isSimonK ? 0x40 : 0x100

                    // write only changed bytes for Atmel
                    for (var pos = 0; pos < eeprom.byteLength; ++pos) {
                        var offset = pos

                        // find the longest span of modified bytes
                        while (eeprom[pos] != eepromImage[pos] && (pos - offset) <= max_bytes_per_write) {
                            ++pos
                        }

                        // byte unchanged, continue
                        if (offset == pos) {
                            continue
                        }

                        // write span
                        promise = promise
                        .then(_4way.writeEEprom.bind(_4way, offset, eepromImage.subarray(offset, pos)))
                    }

                    return promise
                })
            })
        }

        var escSettingArrayTmp;

        function checkESCAndMCU(message) {
            escSettingArrayTmp = message.params;
            var isEncrypted = false;
            if (!isAtmel) {
                const payload = buf2ascii(flashImage.subarray(0x1400, 0x1403));
                if (payload == 'TLX' || payload == 'TLY') isEncrypted = true;
            }
            if (isEncrypted) {
                for (var i = BLHELI_SILABS_EEPROM_OFFSET; i < BLHELI_SILABS_EEPROM_OFFSET + BLHELI_LAYOUT_SIZE; i++) {
                    flashImage[i] = escSettingArrayTmp[i - BLHELI_SILABS_EEPROM_OFFSET];
                }
            }

            const settings_image = isAtmel ? eepromImage : flashImage.subarray(BLHELI_SILABS_EEPROM_OFFSET);

            // check LAYOUT
            var target_layout = escSettingArrayTmp.subarray(BLHELI_LAYOUT.LAYOUT.offset, BLHELI_LAYOUT.LAYOUT.offset + BLHELI_LAYOUT.LAYOUT.size),
                fw_layout = settings_image.subarray(BLHELI_LAYOUT.LAYOUT.offset, BLHELI_LAYOUT.LAYOUT.offset + BLHELI_LAYOUT.LAYOUT.size);

            if (!compare(target_layout, fw_layout)) {
                var target_layout_str = buf2ascii(target_layout).trim();
                if (target_layout_str.length == 0) {
                    target_layout_str = 'EMPTY'
                }

                if (!self.state.ignoreMCULayout) {
                    throw new Error(chrome.i18n.getMessage('layoutMismatch', [ target_layout_str, buf2ascii(fw_layout).trim() ]));
                }
            }

            // check MCU, if it does not match there's either wrong HEX or corrupted ESC. Disallow for now
            var target_mcu = escSettingArrayTmp.subarray(BLHELI_LAYOUT.MCU.offset, BLHELI_LAYOUT.MCU.offset + BLHELI_LAYOUT.MCU.size),
                fw_mcu = settings_image.subarray(BLHELI_LAYOUT.MCU.offset, BLHELI_LAYOUT.MCU.offset + BLHELI_LAYOUT.MCU.size);
            if (!compare(target_mcu, fw_mcu)) {
                var target_mcu_str = buf2ascii(target_mcu).trim();
                if (target_mcu_str.length == 0) {
                    target_mcu_str = 'EMPTY'
                }

                if (!self.state.ignoreMCULayout) {
                    throw new Error(chrome.i18n.getMessage('mcuMismatch', [ target_mcu_str, buf2ascii(fw_mcu).trim() ]));
                }
            }

            // @todo check NAME for **FLASH*FAILED**
        }

        function writeEEpromSafeguard() {
            escSettingArrayTmp.set(ascii2buf('**FLASH*FAILED**'), BLHELI_LAYOUT.NAME.offset)

            var promise = _4way.write(BLHELI_SILABS_EEPROM_OFFSET, escSettingArrayTmp)
            .then(function(message) {
                return _4way.read(message.address, BLHELI_LAYOUT_SIZE)
            })
            .then(function(message) {
                if (!compare(escSettingArrayTmp, message.params)) {
                    throw new Error('failed to verify write **FLASH*FAILED**')
                }
            })

            return promise
        }

        function writeBootloaderFailsafe() {
            var ljmp_reset = new Uint8Array([ 0x02, 0x19, 0xFD ]),
                ljmp_bootloader = new Uint8Array([ 0x02, 0x1C, 0x00 ])

            var pageZeroUsed = false
            for (var i = 0; i < 0x200; i++) {
                if (flashImage[i] != 0xff) {
                    pageZeroUsed = true
                    break
                }
            }
            // for encrypted images don't mess with page 0 etc
            if (!pageZeroUsed) return
            
            var promise = _4way.read(0, 3)
            // verify LJMP reset
            .then(function(message) {
                if (!compare(ljmp_reset, message.params)) {
                    // @todo LJMP bootloader is probably already there and we could skip some steps
                }
            })
            // erase second page
            .then(erasePage.bind(undefined, 1))
            // write LJMP bootloader
            .then(_4way.write.bind(_4way, 0x200, ljmp_bootloader))
            // read LJMP bootloader
            .then(_4way.read.bind(_4way, 0x200, ljmp_bootloader.byteLength))
            // verify LJMP bootloader
            .then(function(message) {
                if (!compare(ljmp_bootloader, message.params)) {
                    throw new Error('failed to verify `LJMP bootloader` write')
                }
            })
            // erase first page
            .then(erasePage.bind(undefined, 0))
            // ensure page erased to 0xFF
            // @todo it could be beneficial to reattempt erasing first page in case of failure
            .then(() => {
                var begin_address   = 0,
                    end_address     = 0x200,
                    step            = 0x80,
                    promise         = Q();

                for (var address = begin_address; address < end_address; address += step) {
                    promise = promise.then(_4way.read.bind(_4way, address, step))
                    .then(function(message) {
                        const erased = message.params.every(x => x == 0xFF);
                        if (!erased) {
                            throw new Error('failed to verify erasure of the first page');
                        }

                        updateProgress(message.params.byteLength);
                    })
                }

                return promise
            });

            return promise
        }

        function reset() {
            var promise = Q()
            promise = promise.then(_4way.reset());
            return promise;
        }

        function erasePages(from_page, max_page) {
            var promise = Q()

            for (var page = from_page; page < max_page; ++page) {
                promise = promise.then(_4way.pageErase.bind(_4way, page))
                .then(function() {
                    updateProgress(BLHELI_SILABS_PAGE_SIZE)
                })
            }

            return promise;
        }

        function erasePage(page) {
            return erasePages(page, page + 1);
        }

        function writePages(begin, end) {
            var begin_address   = begin * BLHELI_SILABS_PAGE_SIZE,
                end_address     = end * BLHELI_SILABS_PAGE_SIZE,
                step            = 0x100,
                promise         = Q()

            for (var address = begin_address; address < end_address; address += BLHELI_SILABS_PAGE_SIZE) {
                for (var i = address; i < address + BLHELI_SILABS_PAGE_SIZE; i++) {
                    if (flashImage[i] != 0xff) {
                        promise = promise.then(erasePage.bind(undefined, (address / BLHELI_SILABS_PAGE_SIZE)));
                        for (var l = address; l < address + BLHELI_SILABS_PAGE_SIZE; l += step) {
                            promise = promise.then(_4way.write.bind(_4way, l, flashImage.subarray(l, l + step)))
                                .then(function() {
                                    updateProgress(step)
                                })
                        }
                        promise = verifyPages(promise, address / BLHELI_SILABS_PAGE_SIZE, address / BLHELI_SILABS_PAGE_SIZE + 1);
                        break;
                    }
                }
            }
            
            return promise
        }

        function writePage(page) {
            return writePages(page, page + 1)
        }

        function verifyPages(promise, begin, end) {
            var begin_address   = begin * BLHELI_SILABS_PAGE_SIZE,
                end_address     = end * BLHELI_SILABS_PAGE_SIZE,
                step            = 0x80
///            ,
 //               promise         = Q()

            for (var address = begin_address; address < end_address; address += step) {
                promise = promise.then(_4way.read.bind(_4way, address, step))
                .then(function(message) {
                    if (!compare(message.params, flashImage.subarray(message.address, message.address + message.params.byteLength))) {
                        throw new Error('failed to verify write at address 0x' + message.address.toString(0x10))
                    }

                    updateProgress(message.params.byteLength)
                })
            }

            return promise
        }
    },
    selectFirmwareForFlashAll: function() {
        // Get indices of all available ESCs
        const escsToFlash = this.state.escMetainfo.map((info, idx) => info.available ? idx : undefined).filter(_ => _ !== undefined);

        this.setState({
            selectingFirmware: true,
            escsToFlash: escsToFlash,
            selectJESC: true
        });
    },
    selectFirmwareForFlashAllTlm: function() {
        // Get indices of all available ESCs
        const escsToFlash = this.state.escMetainfo.map((info, idx) => info.available ? idx : undefined).filter(_ => _ !== undefined);

        this.setState({
            selectingFirmware: true,
            escsToFlash: escsToFlash,
            selectJESC: false
        });
    },
    flashAll: async function(hex, eep) {
        function getBytesToFlash(flash) {
            var bytesToFlash = 0;
            for (var i = 0; i < flash.byteLength; i+=BLHELI_SILABS_PAGE_SIZE) {
                for (var j = i; j < i + BLHELI_SILABS_PAGE_SIZE; j++) {
                    if (flash[j] != 0xff) {
                        bytesToFlash += BLHELI_SILABS_PAGE_SIZE;
                        break;
                    }
                }
            }
            return bytesToFlash * 3;
        }

        $('a.connect').addClass('disabled');

        this.setState({ isFlashing: true });
        
        try{
        // @todo perform some sanity checks on size of flash 

       for (let i = 0; i < this.state.escsToFlash.length; ++i) {

            const escIndex = this.state.escsToFlash[i];

            const metaInfo = this.state.escMetainfo[escIndex],
                  interfaceMode = metaInfo.interfaceMode,
                  signature = metaInfo.signature,
                  isAtmel = [ _4way_modes.AtmBLB, _4way_modes.AtmSK ].includes(interfaceMode);
            
            const flashSize = (() => {
                switch (interfaceMode) {
                case _4way_modes.SiLC2: return BLHELI_SILABS_FLASH_SIZE;
                case _4way_modes.SiLBLB: {
                    const MCU = findMCU(signature, this.state.supportedESCs.signatures[BLHELI_TYPES.BLHELI_S_SILABS]) || findMCU(signature, this.state.supportedESCs.signatures.SiLabs);
                    return MCU.flash_size;
                }
                case _4way_modes.AtmBLB:
                case _4way_modes.AtmSK: {
                    const MCU = findMCU(signature, this.state.supportedESCs.signatures.Atmel);
                    return MCU.flash_size;
                }
                default: throw Error('unknown interfaceMode ' + interfaceMode);
                }
            })();

            
            
            var newHex = hex;
            try {
                
                if (newHex instanceof String) {
                    newHex = newHex.replace('{1}', metaInfo.uid);
                    var deferred = Q.defer();
                    $.get(newHex, function (content) {
                        return deferred.resolve(content);
                    }).fail(function () {
                        return deferred.reject(new Error('File is unavailable'));
                    })
                    ;
                    newHex = await deferred.promise;
                }
                

                const flash = fillImage(await parseHex(newHex), flashSize);
                var eeprom;
                if (eep) {
                    eeprom = fillImage(await parseHex(eep), BLHELI_ATMEL_EEPROM_SIZE);
                }
                
                var isEncrypted = false;
                if (!isAtmel) {
                    const payload = buf2ascii(flash.subarray(0x1400, 0x1403));
                    if (payload == 'TLX' || payload == 'TLY') isEncrypted = true;
                    // Check pseudo-eeprom page for BLHELI signature
                    const MCU = buf2ascii(flash.subarray(BLHELI_SILABS_EEPROM_OFFSET).subarray(BLHELI_LAYOUT.MCU.offset).subarray(0,BLHELI_LAYOUT.MCU.size));
                    // Check instruction at the start of address space
                    const firstBytes = flash.subarray(0, 3);
                    const ljmpReset = new Uint8Array([ 0x02, 0x19, 0xFD ]);
                    const ljmpCheckBootload = new Uint8Array([ 0x02, 0x19, 0xE0 ]);
                    
                    
                    // BLHeli_S uses #BLHELI$.
                    // @todo add additional sanitize here to prevent user from flashing BLHeli_S on BLHeli ESC and vice versa
                    if (!isEncrypted && (!(MCU.includes('#BLHELI#') || MCU.includes('#BLHELI$')) || (!compare(firstBytes, ljmpReset) && !compare(firstBytes, ljmpCheckBootload)))) {
                        throw new Error(chrome.i18n.getMessage('hexInvalidSiLabs'));
                    }
                } else {
                    // @todo check first 2 bytes of flash as well
                    
                    const MCU = buf2ascii(eeprom.subarray(BLHELI_LAYOUT.MCU.offset).subarray(0, BLHELI_LAYOUT.MCU.size));
                    if (!MCU.includes('#BLHELI#')) {
                        throw new Error('EEP does not look like a valid Atmel BLHeli EEprom file');
                    }
                }

//                const escIndex = this.state.escsToFlash[i];

                GUI.log(chrome.i18n.getMessage('escFlashingStarted', [ escIndex + 1 ]));
                var escSettings = this.state.escSettings[escIndex],
                    escMetainfo = this.state.escMetainfo[escIndex];

                this.setState({
                    flashingEscIndex: escIndex,
                    flashingEscProgress: 0
                });

                    const startTimestamp = Date.now()
                var status = { "bytes_to_process" : getBytesToFlash(flash), "bytes_processed" : 0 };
                    
                    if (!this.state.escMetainfo[escIndex].isActivated && this.state.escMetainfo[escIndex].isLicensed)
                    {
                        var URL = 'https://jflight.net/cgi-bin/encrypt/{1}/bl0102/0';
                        URL = URL.replace('{1}', this.state.escMetainfo[escIndex].uid);

                        var deferred = Q.defer();
                        $.get(URL, function (content) {
                            return deferred.resolve(content);
                        }).fail(function () {
                            return deferred.reject(new Error('File is unavailable'));
                        });
                        var bshex = await deferred.promise;
                            
                        const bsFlash = fillImage(await parseHex(bshex), flashSize);
                        status.bytes_to_process += getBytesToFlash(bsFlash);
                        await this.flashFirmwareImpl(escIndex, escSettings, escMetainfo, bsFlash, eeprom,
                                                     progress => {
                                                         this.setState({ flashingEscProgress: progress })
                                                     }, true, status);
                        this.state.escMetainfo[escIndex].isActivated = true;
                    }

                    await this.flashFirmwareImpl(escIndex, escSettings, escMetainfo, flash, eeprom,
                        progress => {
                            this.setState({ flashingEscProgress: progress })
                        }, isEncrypted, status);

                    const elapsedSec = (Date.now() - startTimestamp) * 1.0e-3;
                    GUI.log(chrome.i18n.getMessage('escFlashingFinished', [ escIndex + 1, elapsedSec ]));
                    googleAnalytics.sendEvent('ESC', 'FlashingFinished', 'After', elapsedSec.toString());
                } catch (error) {
                    GUI.log(chrome.i18n.getMessage('escFlashingFailed', [ escIndex + 1, error.stack ]));
                    googleAnalytics.sendEvent('ESC', 'FlashingFailed', 'Error', error.stack);
                }

                this.setState({
                    flashingEscIndex: undefined,
                    flashingEscProgress: 0
                })
            }
        } catch (error) {
            GUI.log(chrome.i18n.getMessage('flashingFailedGeneral', [ error.stack ]));
            googleAnalytics.sendEvent('ESC', 'FirmwareValidationFailed', 'Error', error.stack);
        }

        // read settings back
        await this.readSetup();
        this.setState({ isFlashing: false });

        $('a.connect').removeClass('disabled');
//dialog.info("Don't forget to flash the Telemetry Service using the \"Flash All\" button");
    },
    handleIgnoreMCULayout: function(e) {
        this.setState({
            ignoreMCULayout: e.target.checked
        });
    },
    render: function() {
        if (!this.state.supportedESCs || !this.state.firmwareVersions) return null;

        return (
            <div className="tab-esc toolbar_fixed_bottom">
                <div className="content_wrapper">
                    <div className={this.state.noteStyle}>
                        <div className="note_spacer">
                            <p dangerouslySetInnerHTML={{
                                __html: chrome.i18n.getMessage(this.state.noteText)}} />
                        </div>
                    </div>
                    {this.renderContent()}
                </div>
                <div className="content_toolbar">
                    <div className="btn log_btn">
                        <a
                            href="#"
                            onClick={this.saveLog}
                        >
                            {chrome.i18n.getMessage('escButtonSaveLog')}
                        </a>
                    </div>
                    <div className="btn">
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.isFlashing && this.state.canRead ? "" : "disabled"}
                            onClick={this.readSetup}
                        >
                            {chrome.i18n.getMessage('escButtonRead')}
                        </a>
                    </div>
                    <div className="btn">
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.isFlashing && this.state.canWrite ? "" : "disabled"}
                            onClick={this.writeSetup}
                        >
                            {chrome.i18n.getMessage('escButtonWrite')}
                        </a>
                    </div>
                    <div className={this.state.canResetDefaults ? "btn" : "hidden"}>
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.IsFlashing && this.state.canWrite ? "" : "disabled"}
                            onClick={this.resetDefaults}
                        >
                            {chrome.i18n.getMessage('resetDefaults')}
                        </a>
                    </div>
                    <div className="btn">
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.isFlashing && this.state.canFlashTlm ? "" : "disabled"}
                            onClick={this.selectFirmwareForFlashAllTlm}
                        >
                            {chrome.i18n.getMessage('escButtonFlashAllTlm')}
                        </a>
                    </div>
                    <div className="btn">
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.isFlashing && this.state.canFlash ? "" : "disabled"}
                            onClick={this.selectFirmwareForFlashAll}
                        >
                            {chrome.i18n.getMessage('escButtonFlashAll')}
                        </a>
                    </div>
                    <div className="btn">
                        <a
                            href="#"
                            className={!this.state.selectingFirmware && !this.state.isLicensed && this.props.escCount > 0 && !this.state.licensingAll ? "" : "disabled"}
                            onClick={this.licenseAll}
                        >
                            {chrome.i18n.getMessage('escButtonLicenseAll')}
                        </a>
                    </div>
                </div>
            </div>
        );
    },
    renderContent: function() {
        const noneAvailable = !this.state.escMetainfo.some(info => info.available);
        if (noneAvailable) {
            return null;
        }

        return (
            <div>
                {this.renderWrappers()}
            </div>
        );
    },
    loadstop: function() {
        if (this.webview.src.includes('return=1') && !this.webviewDone) {
            this.webview.removeEventListener('loadstop', this.lffunc);
            this.webviewDone = true;
            this.setState({
                licensingAll: false
            });
            this.readSetup();
        }
    },
    renderWrappers: function() {
        if (this.state.selectingFirmware) {
            const firstAvailableIndex = this.state.escsToFlash[0];
            const firstAvailableMetainfo = this.state.escMetainfo[firstAvailableIndex];
            const firstAvailableEsc = this.state.escSettings[firstAvailableIndex];

            return [
              <div className="checkbox">
                    <label>
                        <input
                            type="checkbox"
                            onChange={this.handleIgnoreMCULayout}
                            checked={this.state.ignoreMCULayout}
                        />
                        <span>
                            {chrome.i18n.getMessage('escIgnoreInappropriateMCULayout')}
                            <span
                                className={this.state.ignoreMCULayout ? 'red' : 'hidden'}
                            >
                                {chrome.i18n.getMessage('escIgnoreInappropriateMCULayoutWarning')}
                            </span>
                        </span>
                    </label>
                </div>,
                <FirmwareSelector
                    supportedESCs={this.state.supportedESCs}
                    firmwareVersions={this.state.firmwareVersions}
                    signatureHint={firstAvailableMetainfo.signature}
                    escHint={firstAvailableEsc.LAYOUT}
                    modeHint={blheliModeToString(firstAvailableEsc.MODE)}
                    onFirmwareLoaded={this.onFirmwareLoaded}
                    onCancel={this.onFirmwareSelectorCancel}
                    selectJESC = {this.state.selectJESC}
                />
            ];
        } else if(this.state.licensingAll) {
            var url = 'https://jflight.net/index.php?route=account/esc';
            for (var i = 0; i < this.props.escCount; i++) {
                url += '&uid' + (i+1) + '=' + this.state.escMetainfo[i].uid;
            }
            return <div className="webView" ><webview ref={elem => { if( elem != null) { elem.addEventListener("loadstop", this.lffunc = this.loadstop.bind(this)); this.webviewDone = false; this.webview = elem;}}} autosize="on" src={url} ></webview></div>
        }
        

        return (
            <div>
                <div className="leftWrapper common-config">
                    {this.renderCommonSettings()}
                </div>
                <div className="rightWrapper individual-config">
                    {this.renderIndividualSettings()}
                </div>
            </div>
        );
    },
    renderCommonSettings: function() {
        return (
            <CommonSettings
                escSettings={this.state.escSettings}
                escMetainfo={this.state.escMetainfo}
                supportedESCs={this.state.supportedESCs}
                onUserInput={this.onUserInput}
            />
        );
    },
    renderIndividualSettings: function() {
        return this.state.escMetainfo.map((info, idx) => {
            if (!info.available) {
                return null;
            }

            return (
                <IndividualSettings
                    escIndex={idx}
                    escSettings={this.state.escSettings}
                    escMetainfo={this.state.escMetainfo}
                    supportedESCs={this.state.supportedESCs}
                    onUserInput={this.onUserInput}
                    canFlash={!this.state.isFlashing}
                    canFlashTlm={!this.state.isFlashing && this.state.escMetainfo[idx].isLicensed && this.state.escMetainfo[idx].isActivated && this.state.escMetainfo[idx].isJesc}
                    isFlashing={this.state.flashingEscIndex === idx && this.state.selectJESC}
                    isFlashingTlm={this.state.flashingEscIndex === idx && !this.state.selectJESC}
                    progress={this.state.flashingEscProgress}
                    onFlash={this.flashOne}
                />
            );
        });
    },
    onFirmwareLoaded: function(hex, eep) {
        this.setState({
            selectingFirmware: false
        });

        this.flashAll(hex, eep);
    },
    onFirmwareSelectorCancel: function() {
        this.setState({
            selectingFirmware: false
        });
    }
});
