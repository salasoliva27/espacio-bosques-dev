import { ethers } from "hardhat";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../.env.sepolia") });
dotenv.config({ path: path.join(__dirname, "../../.env") });

async function main() {
  const registryAddress = process.env.PROJECT_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("PROJECT_REGISTRY_ADDRESS missing");

  const [signer] = await ethers.getSigners();
  const balanceBefore = await ethers.provider.getBalance(signer.address);
  console.log("Signer:", signer.address);
  console.log("Balance:", ethers.formatEther(balanceBefore), "ETH\n");

  const registry = await ethers.getContractAt("ProjectRegistry", registryAddress, signer);
  const PLANNER_ROLE = await registry.PLANNER_ROLE();
  const hasRole = await registry.hasRole(PLANNER_ROLE, signer.address);
  console.log("PLANNER_ROLE granted to signer?", hasRole);

  if (!hasRole) {
    console.log("\nGranting PLANNER_ROLE to deployer...");
    const grantTx = await registry.grantRole(PLANNER_ROLE, signer.address);
    console.log("  tx:", grantTx.hash);
    console.log("  https://sepolia.etherscan.io/tx/" + grantTx.hash);
    const grantRcpt = await grantTx.wait();
    console.log("  mined in block", grantRcpt?.blockNumber, "| gas:", grantRcpt?.gasUsed.toString());
  }

  console.log("\nCreating test project...");
  const metadataURI = "ipfs://QmTestBosques-Banqueta-Sirio-Lote-A-2026";
  const fundingGoal = ethers.parseUnits("500000", 18); // 500k BOSQUES tokens
  const createTx = await registry.createProject(metadataURI, fundingGoal);
  console.log("  tx:", createTx.hash);
  console.log("  https://sepolia.etherscan.io/tx/" + createTx.hash);
  const createRcpt = await createTx.wait();
  console.log("  mined in block", createRcpt?.blockNumber, "| gas:", createRcpt?.gasUsed.toString());

  const count = await registry.getProjectCount();
  const project = await registry.getProject(count);
  console.log("\nProject #" + count.toString() + ":");
  console.log("  planner:", project.planner);
  console.log("  metadataURI:", project.metadataURI);
  console.log("  fundingGoal:", ethers.formatUnits(project.fundingGoal, 18), "BOSQUES");
  console.log("  status:", project.status.toString(), "(0=Pending)");
  console.log("  createdAt:", new Date(Number(project.createdAt) * 1000).toISOString());

  const balanceAfter = await ethers.provider.getBalance(signer.address);
  console.log("\nGas spent:", ethers.formatEther(balanceBefore - balanceAfter), "ETH");
  console.log("Remaining:", ethers.formatEther(balanceAfter), "ETH");

  console.log("\n=== ON-CHAIN TEST COMPLETE ===");
  console.log("ProjectRegistry on Etherscan:");
  console.log("  https://sepolia.etherscan.io/address/" + registryAddress);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
