# GAS Setup
Create a Google Sheet, open Extensions > Apps Script, paste Code.gs, and run setupDatabase() once. Deploy as a Web App and set the resulting /exec URL in config.json. GAS is used for pairing and initial SDP/ICE signaling; after the WebRTC DataChannel opens, live controls and telemetry use DataChannel directly. Do not share the spreadsheet. No audio/video is stored.
