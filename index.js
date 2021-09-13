const Web3 = require('web3')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { Writable } = require('stream')
const {
  recoverKeystore,
  generateKeystore,
} = require('ethereum-keystore')
const BN = require('bn.js')
const { ERC20ABI, addresses } = require('./tokens')

const providerUrl = 'wss://mainnet.infura.io/ws/v3/b61c1da2a8db4d7ca209e7603b613754'
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
  const keystore = await generateKeystore(privateKey, password)
  fs.writeFileSync(walletPath, JSON.stringify(keystore))
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
  const web3 = new Web3()
  const pathInput = (await readInput('Wallet path: ')).trim()
  const walletPath = path.isAbsolute(pathInput) ? pathInput : path.join(process.cwd(), pathInput)
  const password = await readPassword()
  const dec = fs.readFileSync(walletPath).toString()
  const privateKey = await recoverKeystore(JSON.parse(dec), password)
  return web3.eth.accounts.privateKeyToAccount(privateKey)
}

async function loadBalance() {
  const web3 = new Web3(provider)
  const wallet = await loadWallet()
  const balance = await web3.eth.getBalance(web3.utils.toChecksumAddress(wallet.address))
  console.log(`Balance for ${wallet.address}: ${web3.utils.fromWei(balance)} Eth`)
}

async function sendEth() {
  const { address, privateKey } = await loadWallet()
  const web3 = new Web3(provider)
  const destAddress = (await readInput('Destination address: ')).trim()
  if (!web3.utils.isAddress(destAddress)) {
    throw new Error('Invalid address')
  }
  // estimate gas for 0 cost tx
  const _gasPrice = web3.eth.getGasPrice()
  const _emptyTxGas = web3.eth.estimateGas({
    to: destAddress,
    value: new BN('1')
  })
  const amountEth = (await readInput('Eth Amount: ')).trim()
  const isMax = amountEth.toLowerCase() === 'max'
  if (isNaN(+amountEth) && !isMax) {
    throw new Error('Invalid Ether amount')
  }
  const gasPrice = new BN((await _gasPrice)).div(new BN('10')).add(new BN(await _gasPrice))
  let amountWei
  if (isMax) {
    const balance = await web3.eth.getBalance(address)
    amountWei = new BN(balance).sub(new BN((await _emptyTxGas)).mul(gasPrice))
    console.log(amountWei.toString())
  } else {
    amountWei = web3.utils.toWei(amountEth)
  }
  const tx = {
    from: address,
    to: destAddress,
    value: amountWei,
  }
  const gas = await web3.eth.estimateGas(tx)
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

async function sendToken() {
  const { address, privateKey } = await loadWallet()
  const web3 = new Web3(provider)
  const { symbol, Token, decimals, balance, tokenAddress } = await readToken(address)
  const destAddress = (await readInput('Destination address: ')).trim()
  if (!web3.utils.isAddress(destAddress)) {
    throw new Error('Invalid address')
  }
  const amount = (await readInput('Token Amount: ')).trim()
  const decimalPow = new BN('10').pow(new BN(decimals))
  const isMax = amount.toLowerCase() === 'max'
  if (isNaN(+amount) && !isMax) {
    throw new Error('Invalid token amount')
  }
  if (!isMax && new BN(amount).mul(decimalPow).gt(new BN(balance))) {
    throw new Error('Insufficient funds')
  }
  let amountWithDecimals
  if (isMax) {
    amountWithDecimals = new BN(balance)
  } else {
    amountWithDecimals = new BN(amount).mul(decimalPow)
  }
  const [ gas, gasPrice ] = await Promise.all([
    Token.methods.transfer(destAddress, amountWithDecimals).estimateGas({
      from: address,
    }),
    web3.eth.getGasPrice(),
  ])
  const humanReadableAmount = amountWithDecimals.div(decimalPow).toString()
  console.log('--------------------')
  console.log(`Sending ${humanReadableAmount} ${symbol} from ${address} to ${destAddress} using ${gas} gas at ${Math.floor(gasPrice / 10**9)} gwei (${web3.utils.fromWei(new BN(gasPrice).mul(new BN(gas)))} Eth)`)
  console.log(`Token contract: ${tokenAddress}`)
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
  const data = Token.methods.transfer(destAddress, amountWithDecimals).encodeABI()
  const signedTx = await web3.eth.accounts.signTransaction({
    from: address,
    to: tokenAddress,
    gas,
    type: 0x2,
    maxFeePerGas: gasPrice,
    data,
  }, privateKey)
  const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction)
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

async function update() {
  const web3 = new Web3()
  const pathInput = (await readInput('Wallet path: ')).trim()
  const walletPath = path.isAbsolute(pathInput) ? pathInput : path.join(process.cwd(), pathInput)
  const password = await readPassword()
  const data = fs.readFileSync(walletPath).toString()
  const dec = await decrypt(JSON.parse(data), password)
  const keystore = await generateKeystore(JSON.parse(dec).privateKey, password)
  fs.writeFileSync(`${walletPath}.updated`, JSON.stringify(keystore))
}

async function swap() {
  const { address, privateKey } = await loadWallet()
  const { symbol: fromToken, Token, decimals, balance, tokenAddress } = await readToken(address, 'From token: ')
  const toToken = await readInput('To token: ')
  const amountText = await readInput('Amount: ')
  const amountDecimal = amountText === 'max' ? new BN(balance) : (new BN(amountText).mul(new BN('10').pow(new BN(decimals))))
  const amount = amountDecimal.div(new BN('10').pow(new BN(decimals)))
  const maxSlip = '0.01' // 1%
  let data
  try {
    const { data: _data } = await axios('https://api.0x.org/swap/v1/quote', {
      params: {
        sellToken: fromToken,
        buyToken: toToken,
        slippagePercentage: maxSlip,
        sellAmount: amountDecimal.toString(),
      }
    })
    data = _data
  } catch (err) {
    console.log(err)
    console.log('Error with 0x api')
    return
  }
  const {
    decimals: toDecimals,
    symbol: toSymbol,
  } = await loadToken(data.buyTokenAddress)
  const toAmount = new BN(data.buyAmount).div(new BN('10').pow(new BN(toDecimals)))
  console.log('--------------------')
  console.log('Approving funds for transaction')
  console.log('--------------------')
  {
    const confirm = (await readInput('Proceed (y/n): ')).trim()
    if (confirm !== 'y') {
      console.log('Aborted')
      return
    }
  }
  const web3 = new Web3(provider)
  const approveTx = Token.methods.approve(data.to, amountDecimal).encodeABI()
  {
    // const signedTx = await web3.eth.accounts.signTransaction({
    //   from: address,
    //   to: tokenAddress,
    //   gas: 100000,
    //   gasPrice: data.gasPrice,
    //   data: approveTx,
    // }, privateKey)
    // await web3.eth.sendSignedTransaction(signedTx.rawTransaction)
  }
  console.log('--------------------')
  console.log(`Trading ${amount} ${fromToken} for ${toAmount} ${toSymbol} with a max slippage of ${+maxSlip * 100}%.`)
  console.log(`Gas price: ${data.gasPrice}`)
  console.log('--------------------')
  const confirm = (await readInput('Proceed (y/n): ')).trim()
  if (confirm !== 'y') {
    console.log('Aborted')
    return
  }
  console.log('Broadcasting...')
  const signedTx = await web3.eth.accounts.signTransaction({
    from: address,
    to: data.to,
    gas: Math.ceil(1.4 * +data.gas),
    gasPrice: data.gasPrice,
    data: data.data,
  }, privateKey)
  const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction)
  clearInterval(timer)
  console.log(`Transaction accepted`)
  console.log(`https://etherscan.io/tx/${data.transactionHash}`)
}

async function readToken(ownerAddress, message = 'Token Symbol: ') {
  const symbol = (await readInput(message)).trim().toLowerCase()
  if (!addresses[symbol]) {
    throw new Error('Unknown token')
  }
  return loadToken(addresses[symbol], ownerAddress)
}

async function loadToken(tokenAddress, ownerAddress) {
  const web3 = new Web3(provider)
  const Token = new web3.eth.Contract(ERC20ABI, tokenAddress)
  const [ decimals, symbol, balance ] = await Promise.all([
    Token.methods.decimals().call(),
    Token.methods.symbol().call(),
    ownerAddress ? Token.methods.balanceOf(ownerAddress).call() : Promise.resolve(),
  ])
  return { symbol, decimals, balance, Token, tokenAddress }
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
    if (args.indexOf('sendToken') !== -1) {
      await sendToken()
    }
    if (args.indexOf('sign') !== -1) {
      await signMessage()
    }
    if (args.indexOf('update') !== -1) {
      await update()
    }
    if (args.indexOf('swap') !== -1) {
      await swap()
    }
  } catch (err) {
    console.log(err)
    process.exit(1)
  }
  process.exit(0)
})()
