    // Closing empty default nw.js window; we use the chrome window created in eventPage.js.
    // The window created in eventPage.js also has some hocks to cleanup stuff when closing.
    // Restoring window size, position and state also works out-of-the-box.


function startApplication() {
    var applicationStartTime = new Date().getTime();
    nw.Window.open("main.html", {'id': 'main-window' },
        function (createdWindow) {
          createdWindow.on('close',function() {
            // automatically close the port when application closes
            // save connectionId in separate variable before createdWindow.contentWindow is destroyed
            var connectionId = createdWindow.window.serial.connectionId,
                valid_connection = createdWindow.window.CONFIGURATOR.connectionValid;

            if (connectionId && valid_connection) {
                // Desperately attempt to exit 4way-if mode with a hand-tailored command
                var interfaceExitCmd = new Uint8Array([ 0x2f, 0x34, 0, 0, 1, 0, 0x46, 0xd2 ]);

                chrome.serial.send(connectionId, interfaceExitCmd.buffer, sendInfo => {
                    chrome.serial.disconnect(connectionId, result => {
                        console.log('SERIAL: Connection closed - ' + result);
                    });
                });
            } else if (connectionId) {
                chrome.serial.disconnect(connectionId, function (result) {
                    console.log('SERIAL: Connection closed - ' + result);
                });
            }
            createdWindow.close(true);
    });
        });
}

    startApplication();

    
