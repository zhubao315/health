"""Fetch all body-composition records from Yunmai (好轻) cloud.

Reverse-engineered flow (login -> access token -> chart list), same as the
open-source yunmai extractors. Credentials are passed on the command line and
never written to disk.
"""

import base64, hashlib, json, sys, time, urllib.parse
import requests
from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA

if len(sys.argv) < 3:
    sys.exit("usage: python scripts/fetch_yunmai.py <phone> <password> [out.json]")
ACCOUNT, PASSWORD = sys.argv[1], sys.argv[2]
SECRET = "AUMtyBDV3vklBr6wtA2putAMwtmVcD5b"
UA = (
    "google/android(10,29) channel(huawei) app(4.25,42500010)"
    "screen(w,h=1080,1794)/scale"
)
PUBKEY = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAJKcIu+iATe0QPGIVDzMYsMA6kH9FcY9\n"
    "Or0I4WJJfEgw/N2e0Us/9JVV1CwdV6W2XIl4KqTeH3ydw6tagagPkSsCAwEAAQ==\n"
    "-----END PUBLIC KEY-----"
)


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


account_b64 = base64.b64encode(ACCOUNT.encode()).decode()
account_uri = urllib.parse.quote(account_b64)
cipher = PKCS1_v1_5.new(RSA.importKey(PUBKEY))
password_rsa = (
    base64.b64encode(cipher.encrypt(PASSWORD.encode())).decode().replace("\n", "")
)
password_uri = urllib.parse.quote(password_rsa)

ts = str(int(time.time()))
code = ts[:8] + "00"
loginsign = (
    f"code={code}&deviceUUID=abcd&loginType=1&password={password_rsa}\n"
    f"&signVersion=3&userId=199999999&userName={account_b64}\n&versionCode=7&secret={SECRET}"
)
payload = (
    f"password={password_uri}%0A&code={code}&loginType=1&userName={account_uri}%0A"
    f"&deviceUUID=abcd&versionCode=7&userId=199999999&signVersion=3&sign={md5(loginsign)}"
)
r = requests.post(
    "https://account.iyunmai.com/api/android//user/login.d",
    headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA},
    data=payload,
    timeout=30,
)
print("login:", r.status_code, r.text[:200])
login = r.json()
if login.get("result", {}).get("code") != 0:
    sys.exit("login failed")
info = login["data"]["userinfo"]
refresh, user_id = info["refreshToken"], info["userId"]

ts = str(int(time.time()))
code = ts[:8] + "00"
tokensign = (
    f"code={code}&refreshToken={refresh}&signVersion=3&versionCode=2&secret={SECRET}"
)
tpayload = f"code={code}&refreshToken={refresh}&sign={md5(tokensign)}&signVersion=3&versionCode=2"
tr = requests.post(
    "https://account.iyunmai.com/api/android///auth/token.d",
    headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA},
    data=tpayload,
    timeout=30,
)
print("token:", tr.status_code, tr.text[:160])
token = tr.json()["data"]["accessToken"]

code = str(int(time.time()))
start = str(int(time.time()) - 9999 * 86400)
url = (
    f"https://data.iyunmai.com/api/ios/scale/chart-list.json?code={code}"
    f"&signVersion=3&startTime={start}&userId={user_id}&versionCode=2"
)
dr = requests.get(
    url,
    headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        "accessToken": token,
    },
    timeout=60,
)
print("data:", dr.status_code)
data = dr.json()
rows = data.get("data", {}).get("rows", [])
print("rows:", len(rows))
if rows:
    print("keys:", sorted(rows[0].keys()))
    print("sample:", json.dumps(rows[0], ensure_ascii=False)[:500])
out = sys.argv[3] if len(sys.argv) > 3 else "yunmai_rows.json"
json.dump({"user_id": user_id, "rows": rows}, open(out, "w"), ensure_ascii=False)
print(f"wrote {out}")
