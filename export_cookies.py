"""
Export Instagram cookies from Chrome - Debug version.
Shows what's actually in the cookie DB and why decryption might fail.
"""
import os, sys, json, base64, shutil, sqlite3, ctypes, ctypes.wintypes

class DATA_BLOB(ctypes.Structure):
    _fields_ = [('cbData', ctypes.wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

def dpapi_decrypt(encrypted):
    blob_in = DATA_BLOB(len(encrypted), ctypes.create_string_buffer(encrypted, len(encrypted)))
    blob_out = DATA_BLOB()
    if ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)):
        data = ctypes.string_at(blob_out.pbData, blob_out.cbData)
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
        return data
    return None

def main():
    chrome_user_data = os.path.join(os.environ['LOCALAPPDATA'], 'Google', 'Chrome', 'User Data')
    
    # Get all encryption keys from Local State
    local_state_path = os.path.join(chrome_user_data, 'Local State')
    with open(local_state_path, 'r', encoding='utf-8') as f:
        local_state = json.load(f)
    
    os_crypt = local_state.get('os_crypt', {})
    print(f"os_crypt keys: {list(os_crypt.keys())}")
    
    # Try to get key
    encrypted_key_b64 = os_crypt.get('encrypted_key', '')
    if encrypted_key_b64:
        encrypted_key = base64.b64decode(encrypted_key_b64)
        print(f"encrypted_key prefix: {encrypted_key[:5]}")
        key = dpapi_decrypt(encrypted_key[5:])  # Remove DPAPI prefix
        if key:
            print(f"DPAPI key decrypted OK: {len(key)} bytes")
        else:
            print("DPAPI key decryption FAILED")
            key = None
    else:
        print("No encrypted_key found")
        key = None
    
    # Read cookies DB
    cookie_db = os.path.join(chrome_user_data, 'Default', 'Network', 'Cookies')
    tmp_db = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_debug_cookies.db')
    shutil.copy2(cookie_db, tmp_db)
    
    conn = sqlite3.connect(tmp_db)
    rows = conn.execute(
        "SELECT host_key, name, value, encrypted_value, LENGTH(encrypted_value) FROM cookies WHERE host_key LIKE '%instagram.com'"
    ).fetchall()
    
    print(f"\nFound {len(rows)} Instagram cookies in DB:")
    
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')
    count = 0
    
    # Also get full data for export
    full_rows = conn.execute(
        "SELECT host_key, path, is_secure, expires_utc, name, encrypted_value, value "
        "FROM cookies WHERE host_key LIKE '%instagram.com'"
    ).fetchall()
    
    with open(output_path, 'w') as f:
        f.write("# Netscape HTTP Cookie File\n\n")
        
        for host_key, path, is_secure, expires_utc, name, encrypted_value, value in full_rows:
            cookie_value = None
            
            # Try plain value first
            if value:
                cookie_value = value
                print(f"  {name}: plain value OK")
            elif encrypted_value:
                prefix = encrypted_value[:3]
                print(f"  {name}: encrypted, prefix={prefix}, len={len(encrypted_value)}")
                
                if prefix == b'v20' and key:
                    # v20: 3 byte prefix + 12 byte nonce + ciphertext + 16 byte tag
                    nonce = encrypted_value[3:15]
                    ciphertext_tag = encrypted_value[15:]
                    try:
                        from Cryptodome.Cipher import AES
                        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
                        decrypted = cipher.decrypt_and_verify(ciphertext_tag[:-16], ciphertext_tag[-16:])
                        cookie_value = decrypted.decode('utf-8', errors='replace')
                        print(f"    -> v20 decrypted OK: {cookie_value[:30]}...")
                    except Exception as e:
                        print(f"    -> v20 decrypt FAILED: {e}")
                elif prefix == b'v10' and key:
                    nonce = encrypted_value[3:15]
                    ciphertext_tag = encrypted_value[15:]
                    try:
                        from Cryptodome.Cipher import AES
                        cipher = AES.new(key, AES.MODE_GCM, nonce=nonce)
                        decrypted = cipher.decrypt_and_verify(ciphertext_tag[:-16], ciphertext_tag[-16:])
                        cookie_value = decrypted.decode('utf-8', errors='replace')
                        print(f"    -> v10 decrypted OK: {cookie_value[:30]}...")
                    except Exception as e:
                        print(f"    -> v10 decrypt FAILED: {e}")
                else:
                    # Try raw DPAPI
                    result = dpapi_decrypt(encrypted_value)
                    if result:
                        cookie_value = result.decode('utf-8', errors='replace')
                        print(f"    -> DPAPI decrypted OK")
                    else:
                        print(f"    -> All decryption methods FAILED")
            
            if cookie_value:
                secure = "TRUE" if is_secure else "FALSE"
                domain_dot = "TRUE" if host_key.startswith('.') else "FALSE"
                expires = str(int((expires_utc / 1000000) - 11644473600)) if expires_utc > 0 else "0"
                f.write(f"{host_key}\t{domain_dot}\t{path}\t{secure}\t{expires}\t{name}\t{cookie_value}\n")
                count += 1
    
    conn.close()
    os.remove(tmp_db)
    print(f"\nExportadas {count}/{len(rows)} cookies")

if __name__ == '__main__':
    main()
