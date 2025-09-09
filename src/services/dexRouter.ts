import { Order } from '../types/order';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateMockTxHash() {
  return 'mock-tx-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export class MockDexRouter {
  private basePrice = 1.0;

  async getRaydiumQuote(tokenIn: string, tokenOut: string, amount: number) {
    // Simulate network delay
    await sleep(200 + Math.random() * 300);
    
    // Simulate price variance with some realistic spread
    const priceVariation = 0.98 + Math.random() * 0.04; // 2-6% variance
    const price = this.basePrice * priceVariation;
    const fee = 0.003; // 0.3% fee
    
    console.log(`Raydium quote: ${tokenIn}/${tokenOut} - Price: ${price.toFixed(6)}, Fee: ${(fee * 100).toFixed(2)}%`);
    
    return { 
      price: parseFloat(price.toFixed(6)), 
      fee,
      liquidity: Math.floor(Math.random() * 1000000) + 500000, // Mock liquidity
      slippage: Math.random() * 0.01 // 0-1% slippage
    };
  }

  async getMeteoraQuote(tokenIn: string, tokenOut: string, amount: number) {
    // Simulate network delay
    await sleep(200 + Math.random() * 300);
    
    // Simulate different price variance for Meteora
    const priceVariation = 0.97 + Math.random() * 0.05; // 3-8% variance
    const price = this.basePrice * priceVariation;
    const fee = 0.002; // 0.2% fee (lower than Raydium)
    
    console.log(`Meteora quote: ${tokenIn}/${tokenOut} - Price: ${price.toFixed(6)}, Fee: ${(fee * 100).toFixed(2)}%`);
    
    return { 
      price: parseFloat(price.toFixed(6)), 
      fee,
      liquidity: Math.floor(Math.random() * 800000) + 300000, // Mock liquidity
      slippage: Math.random() * 0.015 // 0-1.5% slippage
    };
  }

  async selectBestDex(tokenIn: string, tokenOut: string, amount: number) {
    console.log(`\n=== DEX Routing Analysis for ${tokenIn}/${tokenOut} (${amount}) ===`);
    
    // Get quotes from both DEXs
    const [raydiumQuote, meteoraQuote] = await Promise.all([
      this.getRaydiumQuote(tokenIn, tokenOut, amount),
      this.getMeteoraQuote(tokenIn, tokenOut, amount)
    ]);

    // Calculate effective prices (after fees)
    const raydiumEffective = raydiumQuote.price * (1 - raydiumQuote.fee);
    const meteoraEffective = meteoraQuote.price * (1 - meteoraQuote.fee);

    // Calculate output amounts
    const raydiumOutput = amount * raydiumEffective;
    const meteoraOutput = amount * meteoraEffective;

    // Determine best DEX based on output amount
    const isRaydiumBetter = raydiumOutput > meteoraOutput;
    const selectedDex = isRaydiumBetter ? 'raydium' : 'meteora';
    const selectedQuote = isRaydiumBetter ? raydiumQuote : meteoraQuote;
    const outputDifference = Math.abs(raydiumOutput - meteoraOutput);
    const percentageDifference = (outputDifference / Math.max(raydiumOutput, meteoraOutput)) * 100;

    const routingDecision = {
      raydium: {
        price: raydiumQuote.price,
        fee: raydiumQuote.fee,
        effectivePrice: raydiumEffective,
        output: raydiumOutput,
        liquidity: raydiumQuote.liquidity,
        slippage: raydiumQuote.slippage
      },
      meteora: {
        price: meteoraQuote.price,
        fee: meteoraQuote.fee,
        effectivePrice: meteoraEffective,
        output: meteoraOutput,
        liquidity: meteoraQuote.liquidity,
        slippage: meteoraQuote.slippage
      },
      selected: selectedDex,
      reason: `${selectedDex} provides ${outputDifference.toFixed(6)} more ${tokenOut} (${percentageDifference.toFixed(2)}% better)`,
      priceDifference: percentageDifference
    };

    console.log(`\n📊 Routing Decision:`);
    console.log(`   Raydium:  ${raydiumOutput.toFixed(6)} ${tokenOut} (${(raydiumQuote.fee * 100).toFixed(2)}% fee)`);
    console.log(`   Meteora:  ${meteoraOutput.toFixed(6)} ${tokenOut} (${(meteoraQuote.fee * 100).toFixed(2)}% fee)`);
    console.log(`   Selected: ${selectedDex.toUpperCase()} - ${routingDecision.reason}`);
    console.log(`==========================================\n`);

    return { 
      dex: selectedDex, 
      quote: selectedQuote,
      decision: routingDecision
    };
  }

  async executeSwap(dex: string, order: Order) {
    console.log(`\n🔄 Executing swap on ${dex.toUpperCase()}`);
    console.log(`   Order: ${order.amount} ${order.tokenIn} → ${order.tokenOut}`);
    
    // Simulate execution time (2-3 seconds)
    const executionTime = 2000 + Math.random() * 1000;
    await sleep(executionTime);
    
    // Simulate final execution price with some slippage
    const slippage = Math.random() * 0.02; // 0-2% slippage
    const basePrice = order.amount * 1.0; // Base price
    const finalPrice = basePrice * (1 + slippage);
    const txHash = generateMockTxHash();
    
    console.log(`   ✅ Swap completed!`);
    console.log(`   Transaction: ${txHash}`);
    console.log(`   Final Price: ${finalPrice.toFixed(6)} ${order.tokenOut}`);
    console.log(`   Slippage: ${(slippage * 100).toFixed(2)}%`);
    console.log(`   Execution Time: ${(executionTime / 1000).toFixed(1)}s\n`);
    
    return { 
      txHash, 
      executedPrice: parseFloat(finalPrice.toFixed(6)),
      slippage: parseFloat((slippage * 100).toFixed(2)),
      executionTime: Math.round(executionTime)
    };
  }
}