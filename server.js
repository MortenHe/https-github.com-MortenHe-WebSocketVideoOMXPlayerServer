//WebSocketServer anlegen
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080, clientTracking: true });

//Filesystem und Path Abfragen fuer Playlist
var path = require('path');

//rm -fr
const fs = require('fs-extra')

//Array Shuffle Funktion
var shuffle = require('shuffle-array');

//Befehle auf Kommandzeile ausfuehren
const { execSync } = require('child_process');

//Je nach Ausfuerung auf pi oder in virtualbox gibt es unterschiedliche Pfade, Mode wird ueber command line uebergeben: node server.js vb
const mode = process.argv[2] ? process.argv[2] : "pi";

//Wert fuer Pfad aus config.json auslesen
const configObj = fs.readJsonSync('./config.json');

//Verzeichnis in dem Symlinks fuer Pseudo-Random Wiedergabe hinterlegt werden
const randomDir = configObj[mode]["randomDir"];

//Timer benachrichtigt in regelmaesigen Abstaenden ueber Aenderung z.B. Zeit
timerID = null;

//Nachrichten an die Clients
var messageObjArr = [];

//Aktuellen Song / Volume / Song innerhalb der Playlist / Playlist / PausedStatus / Random merken, damit Clients, die sich spaeter anmelden, diese Info bekommen
currentSong = null;
currentVolume = 100;
currentPosition = 0;
currentFiles = [];
currentPaused = false;
currentRandom = false;

//Infos aus letzter Session auslesen
try {

    //JSON-Objekt aus Datei holen
    const lastSessionObj = fs.readJsonSync('./lastSession.json');

    //Playlist-Pfad laden
    currentPlaylist = lastSessionObj.path;
}

//wenn lastSession.json noch nicht existiert
catch (e) {

    //keine Playlist laden
    currentPlaylist = "";
}

//Wenn eine Playlist aus der vorherigen Session geladen wurde
if (currentPlaylist) {
    console.log("Load playlist from last session " + currentPlaylist);

    //diese Playlist zu Beginn spielen
    setPlaylist();
}

//Wenn sich ein WebSocket mit dem WebSocketServer verbindet
wss.on('connection', function connection(ws) {
    console.log("new client connected");

    //Timer starten, falls er nicht laeuft
    if (!timerID) {
        startTimer();
    }

    //Wenn WS eine Nachricht an WSS sendet
    ws.on('message', function incoming(message) {

        //Nachricht kommt als String -> in JSON Objekt konvertieren
        var obj = JSON.parse(message);
        //console.log(obj)

        //Werte auslesen
        let type = obj.type;
        let value = obj.value;

        //Array von MessageObjekte erstellen, die an WS gesendet werden
        messageObjArr = [{
            type: type,
            value: value
        }];

        //Pro Typ gewisse Aktionen durchfuehren
        switch (type) {

            //neue Playlist laden
            case "set-playlist":
                console.log("set playlist " + value);

                //Audio-Verzeichnis merken
                currentPlaylist = value;

                //Playlist in Datei merken fuer Neustart
                fs.writeJsonSync('./lastSession.json', { path: value });

                //Setlist erstellen und starten
                setPlaylist();
                break;

            //Song wurde vom Nutzer weitergeschaltet
            case 'change-song':
                console.log("change-song " + value);

                //wenn der naechste Song kommen soll
                if (value) {

                    //Wenn wir noch nicht beim letzten Titel sind
                    if (currentPosition < (currentFiles.length - 1)) {

                        //zum naechsten Titel springen
                        execSync('mocp --next');
                    }

                    //wir sind beim letzten Titel
                    else {

                        //Wenn Titel pausiert war, wieder unpausen
                        if (currentPaused) {
                            execSync('mocp --unpause');
                        }
                        console.log("kein next beim letzten Track");
                    }
                }

                //der vorherige Titel soll kommen
                else {

                    //Wenn wir nicht beim 1. Titel sind
                    if (currentPosition > 0) {

                        //zum vorherigen Titel springen
                        execSync('mocp --previous');
                    }

                    //wir sind beim 1. Titel
                    else {
                        console.log("1. Titel von vorne");

                        //Playlist nochmal von vorne starten
                        execSync('mocp --play');
                    }
                }

                //Es ist nicht mehr pausiert
                currentPaused = false;

                //Zusaetzliche Nachricht an clients, dass nun nicht mehr gemutet ist
                messageObjArr.push({
                    type: "toggle-paused",
                    value: currentPaused
                })
                break;

            //Song hat sich geandert (Aufruf von mocp)
            case 'song-change':

                //neue Song merken und Position in Playlist merken
                currentSong = value;
                currentPosition = currentFiles.indexOf(value);
                console.log("new song " + value + " has position " + (currentPosition));

                //Zusaetzliche Nachricht an clients, welche Position der Titel hat
                messageObjArr.push({
                    type: "set-position",
                    value: (currentPosition)
                });
                break;

            //Playback wurde beendet
            case 'stop':
                //console.log("STOPPED")
                break;

            //Lautstaerke setzen
            case 'set-volume':

                //neue Lautstaerke merken 
                currentVolume = value;

                //Lautstaerke setzen
                let volumeCommand = "sudo amixer sset PCM " + value + "% -M";
                console.log(volumeCommand)
                execSync(volumeCommand);
                break;

            //Pause-Status toggeln
            case 'toggle-paused':

                //Pausenstatus toggeln
                currentPaused = !currentPaused;

                //Wenn pausiert werden soll
                if (currentPaused) {
                    execSync("mocp --pause");
                }

                //es ist pausiert und soll wieder gestartet werden
                else {
                    execSync("mocp --unpause");
                }

                //Geaenderten Wert an Clients schicken
                messageObjArr[0].value = currentPaused;
                break;

            //Random toggle
            case 'toggle-random':

                //Random-Wert togglen
                currentRandom = !currentRandom;

                //Playlist mit neuem Random-Wert neu laden
                setPlaylist();

                //Geanderten Wert an Clients schicken
                messageObjArr[0].value = currentRandom;
                break;

            //Innerhalb des Titels spulen
            case "seek":
                try {

                    //Versuchen aktuelle Sekunden in Titel ermitteln und als Int parsen
                    let currentSecBuffer = execSync('mocp -Q %cs');
                    let currentSecInt = parseInt(currentSecBuffer.toString().trim());

                    //+/- 10 Sek
                    let jumpTo = value ? currentSecInt + 10 : currentSecInt - 10;

                    //In Titel springen
                    execSync("mocp --jump " + jumpTo + "s");
                } catch (e) { }

                //TODO nicht per MessageObj schicken?
                break;
        }

        //Ueber Liste der MessageObjs gehen und an WS senden
        for (ws of wss.clients) {
            for (messageObj of messageObjArr)
                try {
                    ws.send(JSON.stringify(messageObj));
                }
                catch (e) { }
        }
    });

    //WS (einmalig beim Verbinden) ueber aktuellen Titel informieren
    ws.send(JSON.stringify({
        type: "song-change",
        value: currentSong
    }));

    //WS (einmalig beim Verbinden) ueber aktuelles Volume informieren
    ws.send(JSON.stringify({
        type: "set-volume",
        value: currentVolume
    }));

    //WS (einmalig beim Verbinden) ueber aktuellen Position informieren
    ws.send(JSON.stringify({
        type: "set-position",
        value: currentPosition
    }));

    //WS (einmalig beim Verbinden) ueber aktuelles Playlist (Audio-dir) informieren
    ws.send(JSON.stringify({
        type: "set-playlist",
        value: currentPlaylist
    }));

    //WS (einmalig beim Verbinden) ueber aktuellen PausedStatus informieren
    ws.send(JSON.stringify({
        type: "toggle-paused",
        value: currentPaused
    }));

    //WS (einmalig beim Verbinden) ueber aktuelle Filelist informieren
    ws.send(JSON.stringify({
        type: "set-files",
        value: currentFiles
    }));

    //WS (einmalig beim Verbinden) ueber aktuellen RandomState informieren
    ws.send(JSON.stringify({
        type: "toggle-random",
        value: currentRandom
    }));
});

//Timer-Funktion benachrichtigt regelmaessig die WS
function startTimer() {
    console.log("startTimer")

    //TimerID, damit Timer zurueckgesetzt werden kann
    timerID = setInterval(() => {
        //console.log("Send to " + wss.clients.length + " clients")

        //Wenn es keine Clients gibt
        if (wss.clients.length == 0) {
            console.log("No more clients for Timer")

            //Timer zuruecksetzen
            clearInterval(timerID);
            timerID = null;
        }

        //Zeitpunkt in Titel
        let time = "";

        //Versuchen aktuelle Zeit in Titel ermitteln
        try {
            time = execSync('mocp -Q %ct');
            //console.log(time.toString().trim())
        }
        catch (e) { }

        //MessageObj erstellen
        let messageObj = {
            type: "time",
            value: time.toString().trim()
        };

        //MessageObj an WS senden
        for (ws of wss.clients) {
            try {
                ws.send(JSON.stringify(messageObj));
            }
            catch (e) { }
        }
    }, 1000)
}

function setPlaylist() {

    //Liste der files zuruecksetzen
    currentFiles = [];

    //davon ausgehen, dass normale Abspiel-Reihenfolge genutzt wird -> uebergegene Audioordner fuer mocp nutzen
    let audioDir = currentPlaylist;

    //Wenn random abgespielt wird
    if (currentRandom) {

        //Randomdir fuer mocp Playlist nehmen
        audioDir = randomDir;

        //Random Dir loeschen und wieder neu anlegen
        fs.removeSync(randomDir);
        fs.mkdirSync(randomDir);
    }

    //Files aus aktuellem Dir sammeln
    let tempFileArray = [];

    //Ueber Dateien in aktuellem Verzeichnis gehen
    fs.readdirSync(currentPlaylist).forEach(file => {

        //mp3 files in die TempFileArray sammeln
        if (path.extname(file).toLowerCase() === ".mp3") {
            tempFileArray.push(currentPlaylist + "/" + file)
        }
    });

    //Bei Random
    if (currentRandom) {

        //TempFileArray shuffeln
        shuffle(tempFileArray);

        //Ueber geshuffelte TempFiles gehen
        tempFileArray.forEach(function (filePath, index) {

            //0 auffuellen bei Index < 10
            let prefix = (index + 1) < 10 ? "0" + (index + 1) : (index + 1);

            //Symlink in randomDir erstellen
            let symlinkPath = randomDir + "/" + prefix + " - " + path.basename(filePath);
            fs.symlinkSync(filePath, symlinkPath);

            //File merken (aus random Ordner)
            currentFiles.push(symlinkPath);
        });
    }

    //Files unshuffeled aus aktuellem Ordner Ordner
    else {
        currentFiles = tempFileArray;
    }

    //Mocp Playlist leeren, neu befuellen und starten
    execSync('mocp --clear');
    execSync('mocp -a ' + audioDir);
    execSync('mocp --play');

    //Liste des Dateinamen an Clients liefern
    messageObjArr.push({
        type: "set-files",
        value: currentFiles
    });
}