const Web3 = require('web3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { Writable } = require('stream')

const alg = 'aes-256-cbc'

function hash(input) {
  return crypto.createHmac('sha256', input).digest()
}

function encrypt(data, password) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(alg, hash(password), iv)
  const enc = Buffer.concat([cipher.update(data), cipher.final()])
  return {
    iv: iv.toString('hex'),
    data: enc.toString('hex')
  }
}

function decrypt({ iv, data }, password) {
  const decipher = crypto.createDecipheriv(alg, hash(password), Buffer.from(iv, 'hex'))
  const dec = Buffer.concat([decipher.update(data, 'hex'), decipher.final()])
  return dec.toString('utf8')
}

async function newWallet() {
  const web3 = new Web3()
  const entropy = crypto.randomBytes(10240)
  const { address, privateKey } = web3.eth.accounts.create()
  console.log(`Generated wallet address: ${address}`)
  const data = JSON.stringify({ address, privateKey })
  const password = await readPassword()
  const confirm = await readPassword('Confirm: ')
  if (password !== confirm) throw new Error('Password mismatch')
  const enc = JSON.stringify({
    address,
    ...encrypt(data, password)
  })
  fs.writeFileSync(path.join(__dirname, 'wallet.enc'), enc)
}

async function readPassword(prompt = 'Password: ') {
  let muted = false
  const mutableStdout = new Writable({
    write: function(chunk, encoding, callback) {
      if (!muted)
        process.stdout.write(chunk, encoding)
      callback()
    }
  })
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutableStdout,
    terminal: true,
  })
  const promise = new Promise(rs => {
    rl.question(prompt, (password) => {
      rs(password)
      rl.close()
      console.log('\n')
    })
  })
  muted = true
  return await promise
}

async function loadWallet() {
  const password = await readPassword()
  const dec = fs.readFileSync(path.join(__dirname, 'wallet.enc'))
  const wallet = decrypt(JSON.parse(dec), password)
  console.log(wallet)
}

;(async () => {
  const args = process.argv
  if (args.indexOf('new') !== -1) {
    await newWallet()
  }
  if (args.indexOf('load') !== -1) {
    await loadWallet()
  }
  if (args.indexOf('send') !== -1) {
    // send a tx
  }
})()
