import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, web3 } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, createSyncNativeInstruction, createTransferInstruction, NATIVE_MINT } from "@solana/spl-token";
// import { Program } from "@coral-xyz/anchor";
import { VaultContract } from "../target/types/vault_contract";

import BN from 'bn.js';

import * as fs from "fs";


describe("vault_contract", () => {
  console.log('00');
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = provider.wallet;
  // Use workspace program (automatically uses correct program ID from Anchor.toml)
  const program = anchor.workspace.vault_contract as Program<VaultContract>;
  // WSOL mint address
  const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  
  // Test keypairs
  let userA: Keypair;
  let userB: Keypair;
  let vaultStatePDA: PublicKey;
  let vaultStateBump: number;
  // Token accounts
  let managerWSOLAccount: PublicKey;
  let userAWSOLAccount: PublicKey;
  let userBWSOLAccount: PublicKey;

  // Helper function to load keypair from JSON file
  const loadKeypair = (filePath: string): Keypair => {
    const keypairData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Keypair.fromSecretKey(new Uint8Array(keypairData));
  };
  // Helper function to get or create Associated Token Account
  const getOrCreateATA = async (owner: PublicKey, mint: PublicKey): Promise<PublicKey> => {
    const ata = await getAssociatedTokenAddress(mint, owner);
    
    try {
      await connection.getAccountInfo(ata);
      return ata;
    } catch (error) {
      // Create ATA if it doesn't exist
      const createATAInstruction = createAssociatedTokenAccountInstruction(
        wallet.publicKey, // payer
        ata, // ata
        owner, // owner
        mint // mint
      );
      
      const tx = new web3.Transaction().add(createATAInstruction);
      await provider.sendAndConfirm(tx);
      return ata;
    }
  };

  // Helper function to transfer SOL from manager to user
  const transferSOL = async (to: PublicKey, amount: number): Promise<void> => {
    const transferInstruction = web3.SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: to,
      lamports: amount * LAMPORTS_PER_SOL,
    });

    const tx = new web3.Transaction().add(transferInstruction);
    await provider.sendAndConfirm(tx);
    console.log(`Transferred ${amount} SOL to ${to.toString()}`);
  };


  // Helper function to wrap SOL to WSOL
  const wrapSOL = async (user: Keypair, amount: number): Promise<void> => {
    const userWSOLAccount = await getAssociatedTokenAddress(WSOL_MINT, user.publicKey);
    const requiredLamports = amount * LAMPORTS_PER_SOL;
    
    // Create the WSOL account if it doesn't exist
    try {
      const accountInfo = await connection.getAccountInfo(userWSOLAccount);
      if (!accountInfo) {
        const createATAInstruction = createAssociatedTokenAccountInstruction(
          user.publicKey, // payer
          userWSOLAccount, // ata
          user.publicKey, // owner
          WSOL_MINT // mint
        );
        
        const createTx = new web3.Transaction().add(createATAInstruction);
        await provider.sendAndConfirm(createTx, [user]);
      }
    } catch (error) {
      // Account might already exist, continue
    }
    
    // Transfer SOL to WSOL account
    const transferInstruction = web3.SystemProgram.transfer({
      fromPubkey: user.publicKey,
      toPubkey: userWSOLAccount,
      lamports: requiredLamports,
    });

    // Sync native instruction to wrap SOL
    const syncInstruction = createSyncNativeInstruction(userWSOLAccount);

    const tx = new web3.Transaction()
      .add(transferInstruction)
      .add(syncInstruction);

    await provider.sendAndConfirm(tx, [user]);
    console.log(`Wrapped ${amount} SOL to WSOL for user ${user.publicKey.toString()}`);
  };

  // Helper function to check vault state
  const checkVaultState = async (): Promise<void> => {
    const vaultState = await program.account.vaultState.fetch(vaultStatePDA);
    console.log("=== Vault State ===");
    console.log("Manager Wallet:", vaultState.managerWallet.toString());
    console.log("Token Mint:", vaultState.tokenMint.toString());
    console.log("Total Volume:", vaultState.totalVolume.toString());
    console.log("Deposits Count:", vaultState.deposits.length);
    vaultState.deposits.forEach((dep, index) => {
      console.log(`  Deposit ${index}: User=${dep.user.toString()}, Amount=${dep.amount.toString()}`);
    });
  };

  // Helper function to check token balances
  const checkBalances = async (): Promise<void> => {
    console.log("=== Token Balances ===");
    
    const managerBalance = await connection.getTokenAccountBalance(managerWSOLAccount);
    console.log("Manager WSOL Balance:", managerBalance.value.uiAmount);
    
    const userABalance = await connection.getTokenAccountBalance(userAWSOLAccount);
    console.log("User A WSOL Balance:", userABalance.value.uiAmount);
    
    const userBBalance = await connection.getTokenAccountBalance(userBWSOLAccount);
    console.log("User B WSOL Balance:", userBBalance.value.uiAmount);
  };

  before(async () => {
    console.log("Setting up test environment...");
    
    // Load test keypairs
    userA = loadKeypair("./tests/accounts/A.json");
    userB = loadKeypair("./tests/accounts/B.json");
    
    // Request airdrop for manager wallet first (only on devnet)
    const isDevnet = connection.rpcEndpoint.includes('devnet');
    if (isDevnet) {
      console.log("Requesting airdrop for manager on devnet...");
      try {
        await connection.requestAirdrop(wallet.publicKey, 1 * LAMPORTS_PER_SOL);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for airdrop
      } catch (error) {
        console.log("Airdrop failed, continuing with existing balance...");
      }
    } else {
      console.log("Running on localnet - skipping airdrop");
    }
    
    // Transfer SOL to users so they can wrap it to WSOL
    console.log("Transferring SOL to users...");
    await transferSOL(userA.publicKey, 0.1); // Give user A 0.1 SOL
    await transferSOL(userB.publicKey, 0.1); // Give user B 0.1 SOL
    
    // Get or create WSOL token accounts
    console.log("Creating WSOL token accounts...");
    managerWSOLAccount = await getOrCreateATA(wallet.publicKey, WSOL_MINT);
    userAWSOLAccount = await getOrCreateATA(userA.publicKey, WSOL_MINT);
    userBWSOLAccount = await getOrCreateATA(userB.publicKey, WSOL_MINT);
    
    // Users wrap their own SOL to WSOL
    console.log("Users wrapping SOL to WSOL...");
    await wrapSOL(userA, 0.05); // User A wraps 0.05 SOL to WSOL
    await wrapSOL(userB, 0.05); // User B wraps 0.05 SOL to WSOL
    
    // Manager also wraps some SOL to WSOL for withdrawals
    console.log("Manager wrapping SOL to WSOL...");
    await wrapSOL(wallet.payer, 0.1); // Manager wraps 0.1 SOL to WSOL
    
    // Check final balances
    const managerBalance = await connection.getBalance(wallet.publicKey);
    console.log("Manager SOL Balance:", managerBalance / LAMPORTS_PER_SOL);
    const userABalance = await connection.getBalance(userA.publicKey);
    console.log("User A SOL Balance:", userABalance / LAMPORTS_PER_SOL);
    const userBBalance = await connection.getBalance(userB.publicKey);
    console.log("User B SOL Balance:", userBBalance / LAMPORTS_PER_SOL);
    
    console.log("Setup complete!");
  });

  it("1. Initialize vault with WSOL", async () => {
    console.log("\n=== Test 1: Initialize Vault ===");
    
    // Find vault state PDA
    [vaultStatePDA, vaultStateBump] = await PublicKey.findProgramAddress(
      [Buffer.from("vault"), wallet.publicKey.toBuffer()],
      program.programId
    );
    
    console.log("Vault State PDA:", vaultStatePDA.toString());
    
    // Check if vault already exists
    try {
      const existingVault = await program.account.vaultState.fetch(vaultStatePDA);
      console.log("Vault already exists! Skipping initialization.");
      console.log("Existing vault manager:", existingVault.managerWallet.toString());
      console.log("Existing vault token mint:", existingVault.tokenMint.toString());
      console.log("Existing vault total volume:", existingVault.totalVolume.toString());
    } catch (error) {
      console.log("Vault does not exist. Initializing new vault...");
      
      // Initialize vault
      const tx = await program.methods
        .initializeVault(wallet.publicKey, WSOL_MINT, new BN(50)) // Set max_depositors to 50
        .accounts({
          authority: wallet.publicKey,
          vaultState: vaultStatePDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      console.log("Initialize transaction signature:", tx);
    }
    
    // Check vault state
    await checkVaultState();
    await checkBalances();
  });

  it("2. User A deposits 0.1 WSOL", async () => {
    console.log("\n=== Test 2: User A Deposits 0.1 WSOL ===");
    
    const depositAmount = new BN(0.1 * LAMPORTS_PER_SOL); // 0.1 WSOL
    
    const tx = await program.methods
      .deposit(depositAmount)
      .accounts({
        vaultState: vaultStatePDA,
        user: userA.publicKey,
        userTokenAccount: userAWSOLAccount,
        managerTokenAccount: managerWSOLAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc();
    
    console.log("User A deposit transaction signature:", tx);
    
    // Check vault state and balances
    await checkVaultState();
    await checkBalances();
  });

  it("3. User B deposits 0.1 WSOL, then 0.2 WSOL", async () => {
    console.log("\n=== Test 3: User B Deposits 0.1 then 0.2 WSOL ===");
    
    // First deposit: 0.1 WSOL
    const firstDepositAmount = new BN(0.1 * LAMPORTS_PER_SOL);
    
    const tx1 = await program.methods
      .deposit(firstDepositAmount)
      .accounts({
        vaultState: vaultStatePDA,
        user: userB.publicKey,
        userTokenAccount: userBWSOLAccount,
        managerTokenAccount: managerWSOLAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc();
    
    console.log("User B first deposit transaction signature:", tx1);
    
    // Check state after first deposit
    console.log("After first deposit:");
    await checkVaultState();
    await checkBalances();
    
    // Second deposit: 0.2 WSOL
    const secondDepositAmount = new BN(0.2 * LAMPORTS_PER_SOL);
    
    const tx2 = await program.methods
      .deposit(secondDepositAmount)
      .accounts({
        vaultState: vaultStatePDA,
        user: userB.publicKey,
        userTokenAccount: userBWSOLAccount,
        managerTokenAccount: managerWSOLAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc();
    
    console.log("User B second deposit transaction signature:", tx2);
    
    // Check final state
    console.log("After second deposit:");
    await checkVaultState();
    await checkBalances();
  });

  it("4. Manager withdraws 1 WSOL and verifies proportional distribution", async () => {
    console.log("\n=== Test 4: Manager Withdraws 1 WSOL ===");
    
    // Get initial balances
    const initialManagerBalance = await connection.getTokenAccountBalance(managerWSOLAccount);
    const initialUserABalance = await connection.getTokenAccountBalance(userAWSOLAccount);
    const initialUserBBalance = await connection.getTokenAccountBalance(userBWSOLAccount);
    
    console.log("Initial balances:");
    console.log("Manager:", initialManagerBalance.value.uiAmount);
    console.log("User A:", initialUserABalance.value.uiAmount);
    console.log("User B:", initialUserBBalance.value.uiAmount);
    
    // Wrap 0.10 WSOL for manager to distribute
    const withdrawAmount = new BN(1 * LAMPORTS_PER_SOL); // 1 WSOL to distribute
    
    // Calculate expected distribution:
    // A: 0.1 WSOL (25% of 1 total)
    // B: 0.2 WSOL (75% of 1 total)
    // Expected: A gets 250 WSOL, B gets 750 WSOL
    
    const tx = await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        vaultState: vaultStatePDA,
        authority: wallet.publicKey,
        authorityTokenAccount: managerWSOLAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: userAWSOLAccount, isSigner: false, isWritable: true },
        { pubkey: userBWSOLAccount, isSigner: false, isWritable: true },
      ])
      .rpc();
    
    console.log("Withdraw transaction signature:", tx);
    
    // Check final balances
    console.log("Final balances:");
    await checkBalances();
    await checkVaultState();
    
    // Verify proportional distribution
    const finalUserABalance = await connection.getTokenAccountBalance(userAWSOLAccount);
    const finalUserBBalance = await connection.getTokenAccountBalance(userBWSOLAccount);
    
    const userAReceived = finalUserABalance.value.uiAmount! - initialUserABalance.value.uiAmount!;
    const userBReceived = finalUserBBalance.value.uiAmount! - initialUserBBalance.value.uiAmount!;
    
    console.log("\n=== Distribution Verification ===");
    console.log("User A received:", userAReceived, "WSOL (expected: 250)");
    console.log("User B received:", userBReceived, "WSOL (expected: 750)");
    console.log("Total distributed:", userAReceived + userBReceived, "WSOL (expected: 1)");
    
    // Verify proportions (A should get 25%, B should get 75%)
    const totalReceived = userAReceived + userBReceived;
    const aPercentage = (userAReceived / totalReceived) * 0.1;
    const bPercentage = (userBReceived / totalReceived) * 0.1;
    
    console.log("User A percentage:", aPercentage.toFixed(2) + "% (expected: 25%)");
    console.log("User B percentage:", bPercentage.toFixed(2) + "% (expected: 75%)");
  });
});