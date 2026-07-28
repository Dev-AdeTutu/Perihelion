import { MempoolServer } from "./index.js";
import type { Address } from "@perihelion/sdk";

const port = parseInt(process.env.PORT ?? "3000", 10);
const chainId = Number(process.env.PERIHELION_SOURCE_CHAIN_ID ?? 8453);
const verifyingContract = (process.env.PERIHELION_ESCROW_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;
const statusToken = process.env.PERIHELION_MEMPOOL_STATUS_TOKEN;
const server = new MempoolServer({ port, chainId, verifyingContract, statusToken });

await server.start();
