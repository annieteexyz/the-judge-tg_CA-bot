# The Judge Telegram Bot

A Telegram bot that accepts a contract address (CA), submits it to The Judge/Sentinel scanning service, and is designed to share the resulting ruling in a Telegram chat.

## Features

- Accepts contract addresses through Telegram.
- Integrates with the Sentinel contract-scanning endpoint.
- Includes confirmation and payment safeguards before attempting a paid scan.
- Intended for use in a Telegram group.

**Important:** Successful scanning depends on the Sentinel service, payment requirements, network availability, and valid configuration. Do not assume a ruling was produced unless the bot receives and displays the actual service response.

## Requirements

- Node.js and npm
- A Telegram bot token from BotFather
- Sentinel service access and any required payment funds

## Installation

```bash
git clone https://github.com/annieteexyz/the-judge-tg_CA-bot.git
cd the-judge-tg_CA-bot
npm install
```

## Configuration

Configure the Telegram bot token and other required settings locally. Review `index.js` for the expected environment variable names and configuration paths.

Never publish your Telegram token, wallet private key, `.env` files, or other credentials.

## Run

```bash
npm start
```

## Security and payment notes

- Contract scans may require payment.
- Review the amount, network, token, and recipient before authorizing payment.
- If a request times out, do not blindly retry. Check whether a transaction was broadcast first.
- Use a dedicated wallet with only the funds needed for testing.
- Never commit secrets or local backup files.

## Status

Successful live scanning and ruling delivery must be verified in Telegram before the project is described as fully operational.
