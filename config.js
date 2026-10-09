// チームで共有する設定（index.html と各エディタから読み込む）
window.CHART_EDITOR_CONFIG = {
  // ノーツ（.asset）を保存する Google ドライブのフォルダ。
  // ページからの保存・読み込みは Apps Script の NOTES_FOLDER_ID のフォルダに行う（ここはリンク用）
  driveUrl: 'https://drive.google.com/drive/folders/10ugDZ9dDHFa9-Q3CwKn8Z6v_aOJqW1xI?usp=drive_link',

  // Time Shift / Sync Action（ShiftSyncChart の .asset）を保存するフォルダ（保存するのは Apps Script の SHIFTSYNC_FOLDER_ID。ここはリンク用）
  shiftSyncUrl: 'https://drive.google.com/drive/folders/1q7bq6uNX7Kvt0WWNdnjr8Wm3RXxGkgLY?usp=drive_link',

  // 曲（SongData の組み合わせの JSON）を保存するフォルダ（保存するのは Apps Script の SONG_FOLDER_ID。ここはリンク用）
  songUrl: 'https://drive.google.com/drive/folders/1sTwoT5fBbZ-SyAMueKsQWn9-Jx9quE24?usp=drive_link',

  // いらなくなった譜面を移すゴミ箱フォルダ（移すのは Apps Script の TRASH_FOLDER_ID。ここはリンク用）
  trashUrl: 'https://drive.google.com/drive/folders/1zECm_gPsxV2vmoACMdmRhDINRZzx89m2?usp=drive_link',

  // 音源（曲の音声ファイル）を入れる Google ドライブのフォルダ。
  // ページからの読み込みは Apps Script の AUDIO_FOLDER_ID のフォルダから行う（ここはリンク用）
  audioDriveUrl: 'https://drive.google.com/drive/folders/12SSJ2qgAaitkxpuXNrYUMcT1_6AIrxLT?usp=drive_link',

  // 譜面ボード（Google スプレッドシート + Apps Script）の Web アプリ URL。
  // 設定方法は BOARD_SETUP.md を参照。空のままならボードは「未設定」と表示される
  boardApiUrl: 'https://script.google.com/macros/s/AKfycbwCvgOKHxKhzBL3MO_t3RJgGpUZ06Swk8gTzUt3jYJwp21vzuNVa7BE_TcR_g67QmdA/exec',

  // Apps Script 側でキー（スクリプト プロパティ KEY）を設定した場合だけ同じ値を入れる
  boardKey: '',
};
