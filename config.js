// チームで共有する設定（index.html と各エディタから読み込む）
window.CHART_EDITOR_CONFIG = {
  // ノーツ（.asset）を保存する Google ドライブのフォルダ
  driveUrl: 'https://drive.google.com/drive/folders/1W2U0YRj44VVhU1jaeNiUj0k5fWGItDnh?usp=sharing',

  // 譜面ボード（Google スプレッドシート + Apps Script）の Web アプリ URL。
  // 設定方法は BOARD_SETUP.md を参照。空のままならボードは「未設定」と表示される
  boardApiUrl: 'https://script.google.com/macros/s/AKfycbwCvgOKHxKhzBL3MO_t3RJgGpUZ06Swk8gTzUt3jYJwp21vzuNVa7BE_TcR_g67QmdA/exec',

  // Apps Script 側でキー（スクリプト プロパティ KEY）を設定した場合だけ同じ値を入れる
  boardKey: '',
};
