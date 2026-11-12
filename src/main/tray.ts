import { app, Menu, nativeImage, Tray, type BrowserWindow } from "electron";

const IDLE_1X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAZUlEQVQ4je3QsQmEUBCE4U8QLMJOrMQyrhVDCzIyPysQrODERI1MnqdPNPWHDYadgdnl5TFJoD8oIpkG1dGywxKZ71mDDHmkQY9pE2nEDD8MF3z4f8KM8igQNqjtnziivdrg5QYrK4EYTAWEFeMAAAAASUVORK5CYII=";
const IDLE_2X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAAnklEQVRYhe2UuxHCMBBEHyK3I1wBlOEicQEMkV0AdEAbVGBHKMcmUKxDPyf2vRlFN9rdke4OFEVR9s5BqB2BFjhlekzAC/jGXhyApdDpU5LbggGsz8QIAe4pqT3cfAWpBwDOQJ1p/gHemRob5t8XXIAqQGeVZ+6I6/Rr6QCxY+gdNQlpDJ+RWo+UAFIPGNwqbgJ0Rty6nVNCKIqi7JsfuRFMrDv/XuQAAAAASUVORK5CYII=";
const REC_1X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAAjklEQVQ4jWNgGAUUA0ZkzrclKgX/GRms8GtgPMoVfXsijM+CJpvOwMCggc+A////6zAwMGA3gFOQweDneyZpfAawC/17isxHMcCL4TbDG/GfqDqY/3w77cjzApeBTMic9+w/LzAzMtxFwf9Ynpnv+RmBywAUFzAyMMz8z4AaiP//M35nZvx/GpcBo4AKAADeJibIZ5fZyQAAAABJRU5ErkJggg==";
const REC_2X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAA/UlEQVRYhe2UsWpCQRBF784TsoVolfyA+g1qoSCki3UIQUE/IORf7GxCQEGwTSrBxldo/kF/IKmECE/D20lp42jeWyszp73MvZed3QUURVH+O0YSeIzge1usBYRrn4DY4St7tQzNPeJDekYa3PyUhkT8wD7pAIiAza4wAlaPB3VxEHznmb33MqYp5wgwm9dzFXDgF0kT7wAARINCMSbkfcIDh7Vtr5Y+HpfN0RWUJ1EJGcqdMiHj1vOGTXXMYoHKNOoBePqzE6O3uLXPSQuIrwBAJ5GTQTdp+NECDH5PZsVvaQqIP+FHaFvVetQH081JF+M+5zMbpimgKIqi/ALYkTtkG6ovsgAAAABJRU5ErkJggg==";

let tray: Tray | null = null;
let recording = false;

export const isRecording = (): boolean => recording;

function icon(d1: string, d2: string, template: boolean) {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, dataURL: d1 });
  img.addRepresentation({ scaleFactor: 2, dataURL: d2 });
  img.setTemplateImage(template);
  return img;
}

function rebuildMenu(win: BrowserWindow): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      recording
        ? {
            label: "Stop recording & save",
            click: () => win.webContents.send("tray:command", "stop"),
          }
        : {
            label: "Start recording",
            click: () => win.webContents.send("tray:command", "start"),
          },
      { type: "separator" },
      {
        label: "Open Meeting Scribe",
        click: () => {
          win.show();
          win.focus();
        },
      },
      {
        label: "Launch at Login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          rebuildMenu(win);
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

export function createTray(win: BrowserWindow): void {
  tray = new Tray(icon(IDLE_1X, IDLE_2X, true));
  tray.setToolTip("Meeting Scribe");
  rebuildMenu(win);
}

export function setTrayRecording(win: BrowserWindow, rec: boolean): void {
  if (recording === rec || !tray) return;
  recording = rec;
  tray.setImage(
    rec ? icon(REC_1X, REC_2X, false) : icon(IDLE_1X, IDLE_2X, true),
  );
  tray.setToolTip(rec ? "Meeting Scribe - recording" : "Meeting Scribe");
  rebuildMenu(win);
}
