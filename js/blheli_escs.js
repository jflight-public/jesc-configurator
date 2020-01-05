var BLHELI_ESCS_REMOTE = 'https://jflight.net/jesc_escs_1.2.7.json';
var BLHELI_ESCS_LOCAL = './js/blheli_escs.json';
var BLHELI_ESCS_KEY = 'escs';

function findMCU(signature, MCUList) {
    return MCUList.find(MCU => parseInt(MCU.signature) === signature);
}
