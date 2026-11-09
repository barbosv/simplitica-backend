from pathlib import Path
import subprocess,tempfile,json,base64,datetime
out=Path(__file__).with_name('apple-chain.json')
with tempfile.TemporaryDirectory() as td:
 p=Path(td)
 def run(*args):
  return subprocess.check_output(['openssl',*args],cwd=p,stderr=subprocess.DEVNULL)
 for name in ['root','intermediate','leaf']:
  run('ecparam','-name','prime256v1','-genkey','-noout','-out',name+'.key')
  run('req','-new','-key',name+'.key','-subj','/CN=Simplitica Test '+name,'-out',name+'.csr')
 run('req','-new','-x509','-key','root.key','-subj','/CN=Simplitica Test root','-days','3650','-addext','basicConstraints=critical,CA:TRUE','-out','root.pem')
 for name,issuer,ext in [('intermediate','root','basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n1.2.840.113635.100.6.2.1=ASN1:NULL\nauthorityInfoAccess=OCSP;URI:http://ocsp.test/intermediate'),('leaf','intermediate','basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature\n1.2.840.113635.100.6.11.1=ASN1:NULL\nauthorityInfoAccess=OCSP;URI:http://ocsp.test/leaf')]:
  (p/'ext').write_text(ext)
  run('x509','-req','-in',name+'.csr','-CA',issuer+'.pem','-CAkey',issuer+'.key','-CAcreateserial','-days','3650','-extfile','ext','-out',name+'.pem')
  serial=run('x509','-in',name+'.pem','-noout','-serial').decode().strip().split('=')[1]
  expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=3650)).strftime('%y%m%d%H%M%SZ')
  (p/'index').write_text(f'V\t{expiry}\t\t{serial}\tunknown\t/CN=Simplitica Test {name}\n')
  run('ocsp','-issuer',issuer+'.pem','-sha256','-cert',name+'.pem','-reqout',name+'.req')
  responder=name+'-responder'
  run('ecparam','-name','prime256v1','-genkey','-noout','-out',responder+'.key')
  run('req','-new','-key',responder+'.key','-subj','/CN=OCSP '+name,'-out',responder+'.csr')
  (p/'responder-ext').write_text('basicConstraints=critical,CA:FALSE\nextendedKeyUsage=OCSPSigning\n')
  run('x509','-req','-in',responder+'.csr','-CA',issuer+'.pem','-CAkey',issuer+'.key','-CAcreateserial','-days','3650','-extfile','responder-ext','-out',responder+'.pem')
  run('ocsp','-index','index','-rsigner',responder+'.pem','-rkey',responder+'.key','-CA',issuer+'.pem','-reqin',name+'.req','-respout',name+'.ocsp','-ndays','7','-rmd','sha256','-resp_key_id')
 data={name:base64.b64encode(run('x509','-in',name+'.pem','-outform','DER')).decode() for name in ['root','intermediate','leaf']}
 data.update({name+'OCSP':base64.b64encode((p/(name+'.ocsp')).read_bytes()).decode() for name in ['leaf','intermediate']})
 data['leafKey']=(p/'leaf.key').read_text()
 data['signedDate']=int(datetime.datetime.now(datetime.timezone.utc).timestamp()*1000)+120000
 out.write_text(json.dumps(data,indent=2)+'\n')
