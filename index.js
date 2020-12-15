const Web3 = require('web3')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { Writable } = require('stream')

const providerUrl = 'wss://mainnet.infura.io/ws/v3/5b122dbc87ed4260bf9a2031e8a0e2aa'
// const providerUrl = 'wss://rinkeby.infura.io/ws/v3/5b122dbc87ed4260bf9a2031e8a0e2aa'
const provider = new Web3.providers.WebsocketProvider(providerUrl)

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
  const pathInput = (await readInput('Wallet output path: ')).trim()
  const walletPath = path.isAbsolute(pathInput) ? pathInput : path.join(process.cwd(), pathInput)
  const password = await readPassword()
  const confirm = await readPassword('Confirm: ')
  if (password !== confirm) throw new Error('Password mismatch')
  const enc = JSON.stringify({
    address,
    ...encrypt(data, password)
  })
  fs.writeFileSync(walletPath, enc)
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
    })
  })
  muted = true
  return await promise
}

async function readInput(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })
  return await new Promise(rs => {
    rl.question(prompt, (input) => {
      rs(input)
      rl.close()
    })
  })
}

async function loadWallet() {
  const pathInput = (await readInput('Wallet path: ')).trim()
  const walletPath = path.isAbsolute(pathInput) ? pathInput : path.join(process.cwd(), pathInput)
  const password = await readPassword()
  const dec = fs.readFileSync(walletPath)
  const wallet = decrypt(JSON.parse(dec), password)
  return JSON.parse(wallet)
}

async function loadBalance() {
  const web3 = new Web3(provider)
  const wallet = await loadWallet()
  const balance = await web3.eth.getBalance(wallet.address)
  console.log(`Balance for ${wallet.address}: ${web3.utils.fromWei(balance)} Eth`)
}

async function sendEth() {
  const { address, privateKey } = await loadWallet()
  const web3 = new Web3(provider)
  const destAddress = (await readInput('Destination address: ')).trim()
  if (!web3.utils.isAddress(destAddress)) {
    throw new Error('Invalid address')
  }
  const amountEth = (await readInput('Eth Amount: ')).trim()
  if (isNaN(+amountEth)) {
    throw new Error('Invalid Ether amount')
  }
  const amountWei = web3.utils.toWei(amountEth)
  const tx = {
    from: address,
    to: destAddress,
    value: amountWei,
  }
  const [ gas, gasPrice ] = await Promise.all([
    web3.eth.estimateGas(tx),
    web3.eth.getGasPrice(),
  ])
  const data = await web3.eth.accounts.signTransaction({
    ...tx,
    gas,
    gasPrice,
  }, privateKey)
  console.log('--------------------')
  console.log(`Sending ${amountEth} eth from ${address} to ${destAddress} using ${gas} gas at ${Math.floor(gasPrice / 10**9)} gwei`)
  console.log('--------------------')
  const confirm = (await readInput('Proceed (y/n): ')).trim()
  if (confirm !== 'y') {
    console.log('Aborted')
    return
  }
  console.log('Broadcasting...')
  const timer = setInterval(() => {
    console.log('Waiting for block inclusion')
  }, 2000)
  const receipt = await web3.eth.sendSignedTransaction(data.rawTransaction)
  clearInterval(timer)
  console.log(`Transaction accepted`)
  console.log(`https://etherscan.io/tx/${data.transactionHash}`)
}

async function signMessage() {
  const { address, privateKey } = await loadWallet()
  const web3 = new Web3(provider)
  const text = (await readInput('Message to sign: ')).trim()
  const { messageHash, message } = web3.eth.accounts.sign(text, privateKey)
  console.log(`Message: ${message}`)
  console.log(`Hash: ${messageHash}`)
}

;(async () => {
  try {
    const args = process.argv
    if (args.indexOf('new') !== -1) {
      await newWallet()
    }
    if (args.indexOf('load') !== -1) {
      await loadWallet()
    }
    if (args.indexOf('balance') !== -1) {
      await loadBalance()
    }
    if (args.indexOf('send') !== -1) {
      // send a tx
      await sendEth()
    }
    if (args.indexOf('sign') !== -1) {
      await signMessage()
    }
  } catch (err) {
    console.log(err)
    process.exit(1)
  }
  process.exit(0)
})()
