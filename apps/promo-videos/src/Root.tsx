import { Composition, Folder } from "remotion";
import { MeetTheClaws } from "./components/video1/MeetTheClaws";
import { LobsterLearnsCrypto } from "./components/video2/LobsterLearnsCrypto";
import { ALivingOcean } from "./components/video3/ALivingOcean";
import { ClawTokenEconomy } from "./components/video4/ClawTokenEconomy";
import { ArenaBattle } from "./components/video5/ArenaBattle";
import { AITrainingWorld } from "./components/video6/AITrainingWorld";
import { FifteenSkills } from "./components/video7/FifteenSkills";
import { OpenClawProtocol } from "./components/video8/OpenClawProtocol";
import { LearnThenExport } from "./components/video9/LearnThenExport";
import { LivingWorld } from "./components/video10/LivingWorld";
import { TrainAndBattle } from "./components/video11/TrainAndBattle";
import { ClawTokenEconomy2 } from "./components/video12/ClawTokenEconomy2";
import { GameToProduction } from "./components/video13/GameToProduction";
import { DailyStreak } from "./components/video14/DailyStreak";
import { ChooseSpecies } from "./components/video15/ChooseSpecies";
import { AgentLearnsSkill } from "./components/video16/AgentLearnsSkill";
import { ClawLearnsSkill } from "./components/video17/ClawLearnsSkill";
import { OpenClawShowcase } from "./components/video18/OpenClawShowcase";
import { FeatureHighlight } from "./components/video19/FeatureHighlight";
import { LiveGameplay } from "./components/video20/LiveGameplay";

// Showcase videos
import { AiLobsterAdventure } from "./components/showcase/app-overview/AiLobsterAdventure";
import { WorldOfClawville } from "./components/showcase/app-overview/WorldOfClawville";
import { LearnCryptoCompete } from "./components/showcase/app-overview/LearnCryptoCompete";
import { OpenclawWorld } from "./components/showcase/openclaw-learning/world/OpenclawWorld";
import { KnowledgeDiscovery } from "./components/showcase/openclaw-learning/world/KnowledgeDiscovery";
import { BotExploration } from "./components/showcase/openclaw-learning/world/BotExploration";
import { OpenclawArena } from "./components/showcase/openclaw-learning/arena/OpenclawArena";
import { ArenaBotTraining } from "./components/showcase/openclaw-learning/arena/ArenaBotTraining";
import { BattleAndLearn } from "./components/showcase/openclaw-learning/arena/BattleAndLearn";
import { WatchAndLearn } from "./components/showcase/openclaw-learning/spectator/WatchAndLearn";
import { SpectatorGuide } from "./components/showcase/openclaw-learning/spectator/SpectatorGuide";
import { OpenclawSpectator } from "./components/showcase/openclaw-learning/spectator/OpenclawSpectator";
import { ExploreTheDepths } from "./components/showcase/game-modes/world/ExploreTheDepths";
import { YourLobsterJourney } from "./components/showcase/game-modes/world/YourLobsterJourney";
import { ArenaUltimateTest } from "./components/showcase/game-modes/arena/ArenaUltimateTest";
import { ArenaStrategy } from "./components/showcase/game-modes/arena/ArenaStrategy";
import { Connect30Seconds } from "./components/showcase/openclaw-connect/Connect30Seconds";
import { ZeroToSkill } from "./components/showcase/openclaw-connect/ZeroToSkill";
import { AnonymousPlay } from "./components/showcase/signup/AnonymousPlay";
import { GoAnonymous } from "./components/showcase/signup/GoAnonymous";
import { CreateAccount } from "./components/showcase/signup/CreateAccount";
import { AccountBenefits } from "./components/showcase/signup/AccountBenefits";
import { CompleteWalkthrough } from "./components/showcase/walkthroughs/CompleteWalkthrough";
import { NewPlayerToMaster } from "./components/showcase/walkthroughs/NewPlayerToMaster";
import { DailyRewards } from "./components/showcase/features/DailyRewards";
import { QuestSystem } from "./components/showcase/features/QuestSystem";
import { ClawtokenEconomy } from "./components/showcase/features/ClawtokenEconomy";
import { LobsterPersonalities } from "./components/showcase/features/LobsterPersonalities";
import { NpcMemory } from "./components/showcase/features/NpcMemory";
import { SkillMarketplace } from "./components/showcase/features/SkillMarketplace";

// Combined 14-video series
import { C01_CreateYourLobster } from "./components/combined/C01_CreateYourLobster";
import { C02_ExploreTheDepths } from "./components/combined/C02_ExploreTheDepths";
import { C03_ConnectYourAgent } from "./components/combined/C03_ConnectYourAgent";
import { C04_AgentExploresAutonomously } from "./components/combined/C04_AgentExploresAutonomously";
import { C05_AgentsLearnFromNPCs } from "./components/combined/C05_AgentsLearnFromNPCs";
import { C06_LeaveAgentToLearn } from "./components/combined/C06_LeaveAgentToLearn";
import { C07_ArenaCombat } from "./components/combined/C07_ArenaCombat";
import { C08_TrainAgentInBattle } from "./components/combined/C08_TrainAgentInBattle";
import { C09_SpectateAgentBattles } from "./components/combined/C09_SpectateAgentBattles";
import { C10_BuildExportSkills } from "./components/combined/C10_BuildExportSkills";
import { C11_ClawTokenEconomy } from "./components/combined/C11_ClawTokenEconomy";
import { C12_QuestsAndProgression } from "./components/combined/C12_QuestsAndProgression";
import { C13_GetStartedFree } from "./components/combined/C13_GetStartedFree";
import { C14_AgentLearningPipeline } from "./components/combined/C14_AgentLearningPipeline";

// Promo videos (recording-first)
import { SkillCreationPromo } from "./components/promo/SkillCreationPromo";
import { ArenaGameplayPromo } from "./components/promo/ArenaGameplayPromo";
import { ClawVillePromo } from "./components/promo/ClawVillePromo";

import { FPS } from "./constants/timing";

// Showcase video registry: [compId, component, durationSeconds]
const SHOWCASE = [
  ["showcase-ai-lobster-adventure", AiLobsterAdventure, 18],
  ["showcase-world-of-clawville", WorldOfClawville, 20],
  ["showcase-learn-crypto-compete", LearnCryptoCompete, 20],
  ["showcase-openclaw-world", OpenclawWorld, 18],
  ["showcase-knowledge-discovery", KnowledgeDiscovery, 18],
  ["showcase-bot-exploration", BotExploration, 17],
  ["showcase-openclaw-arena", OpenclawArena, 18],
  ["showcase-arena-bot-training", ArenaBotTraining, 18],
  ["showcase-battle-and-learn", BattleAndLearn, 17],
  ["showcase-watch-and-learn", WatchAndLearn, 17],
  ["showcase-spectator-guide", SpectatorGuide, 18],
  ["showcase-openclaw-spectator", OpenclawSpectator, 17],
  ["showcase-explore-the-depths", ExploreTheDepths, 20],
  ["showcase-your-lobster-journey", YourLobsterJourney, 18],
  ["showcase-arena-ultimate-test", ArenaUltimateTest, 18],
  ["showcase-arena-strategy", ArenaStrategy, 16],
  ["showcase-connect-30-seconds", Connect30Seconds, 15],
  ["showcase-zero-to-skill", ZeroToSkill, 20],
  ["showcase-anonymous-play", AnonymousPlay, 16],
  ["showcase-go-anonymous", GoAnonymous, 15],
  ["showcase-create-account", CreateAccount, 18],
  ["showcase-account-benefits", AccountBenefits, 16],
  ["showcase-complete-walkthrough", CompleteWalkthrough, 20],
  ["showcase-new-player-to-master", NewPlayerToMaster, 18],
  ["showcase-daily-rewards", DailyRewards, 16],
  ["showcase-quest-system", QuestSystem, 17],
  ["showcase-clawtoken-economy", ClawtokenEconomy, 18],
  ["showcase-lobster-personalities", LobsterPersonalities, 18],
  ["showcase-npc-memory", NpcMemory, 18],
  ["showcase-skill-marketplace", SkillMarketplace, 18],
] as const;

// Combined 14-video series: [compId, component, durationSeconds]
const COMBINED = [
  ["c01-create-your-lobster", C01_CreateYourLobster, 30],
  ["c02-explore-the-depths", C02_ExploreTheDepths, 30],
  ["c03-connect-your-agent", C03_ConnectYourAgent, 28],
  ["c04-agent-explores-autonomously", C04_AgentExploresAutonomously, 30],
  ["c05-agents-learn-from-npcs", C05_AgentsLearnFromNPCs, 30],
  ["c06-leave-agent-to-learn", C06_LeaveAgentToLearn, 30],
  ["c07-arena-combat", C07_ArenaCombat, 28],
  ["c08-train-agent-in-battle", C08_TrainAgentInBattle, 30],
  ["c09-spectate-agent-battles", C09_SpectateAgentBattles, 35],
  ["c10-build-export-skills", C10_BuildExportSkills, 32],
  ["c11-clawtoken-economy", C11_ClawTokenEconomy, 28],
  ["c12-quests-and-progression", C12_QuestsAndProgression, 28],
  ["c13-get-started-free", C13_GetStartedFree, 30],
  ["c14-agent-learning-pipeline", C14_AgentLearningPipeline, 35],
] as const;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="Vertical">
        <Composition
          id="meet-the-claws-vertical"
          component={MeetTheClaws}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="lobster-learns-crypto-vertical"
          component={LobsterLearnsCrypto}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="a-living-ocean-vertical"
          component={ALivingOcean}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="clawtoken-economy-vertical"
          component={ClawTokenEconomy}
          durationInFrames={18 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="arena-battle-vertical"
          component={ArenaBattle}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="ai-training-world-vertical"
          component={AITrainingWorld}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="fifteen-skills-vertical"
          component={FifteenSkills}
          durationInFrames={18 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="openclaw-protocol-vertical"
          component={OpenClawProtocol}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="learn-then-export-vertical"
          component={LearnThenExport}
          durationInFrames={16 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="living-world-vertical"
          component={LivingWorld}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="train-and-battle-vertical"
          component={TrainAndBattle}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="clawtoken-economy-v2-vertical"
          component={ClawTokenEconomy2}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="game-to-production-vertical"
          component={GameToProduction}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="daily-streak-vertical"
          component={DailyStreak}
          durationInFrames={16 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="choose-species-vertical"
          component={ChooseSpecies}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="agent-learns-skill-vertical"
          component={AgentLearnsSkill}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="claw-learns-skill-vertical"
          component={ClawLearnsSkill}
          durationInFrames={28 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="openclaw-showcase-vertical"
          component={OpenClawShowcase}
          durationInFrames={55 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="feature-highlight-vertical"
          component={FeatureHighlight}
          durationInFrames={70 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
        <Composition
          id="live-gameplay-vertical"
          component={LiveGameplay}
          durationInFrames={90 * FPS}
          fps={FPS}
          width={1080}
          height={1920}
        />
      </Folder>
      <Folder name="Landscape">
        <Composition
          id="meet-the-claws-landscape"
          component={MeetTheClaws}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="lobster-learns-crypto-landscape"
          component={LobsterLearnsCrypto}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="a-living-ocean-landscape"
          component={ALivingOcean}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="clawtoken-economy-landscape"
          component={ClawTokenEconomy}
          durationInFrames={18 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="arena-battle-landscape"
          component={ArenaBattle}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="ai-training-world-landscape"
          component={AITrainingWorld}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="fifteen-skills-landscape"
          component={FifteenSkills}
          durationInFrames={18 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="openclaw-protocol-landscape"
          component={OpenClawProtocol}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="learn-then-export-landscape"
          component={LearnThenExport}
          durationInFrames={16 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="living-world-landscape"
          component={LivingWorld}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="train-and-battle-landscape"
          component={TrainAndBattle}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="clawtoken-economy-v2-landscape"
          component={ClawTokenEconomy2}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="game-to-production-landscape"
          component={GameToProduction}
          durationInFrames={17 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="daily-streak-landscape"
          component={DailyStreak}
          durationInFrames={16 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="choose-species-landscape"
          component={ChooseSpecies}
          durationInFrames={15 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="agent-learns-skill-landscape"
          component={AgentLearnsSkill}
          durationInFrames={20 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="claw-learns-skill-landscape"
          component={ClawLearnsSkill}
          durationInFrames={28 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="openclaw-showcase-landscape"
          component={OpenClawShowcase}
          durationInFrames={55 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="feature-highlight-landscape"
          component={FeatureHighlight}
          durationInFrames={70 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
        <Composition
          id="live-gameplay-landscape"
          component={LiveGameplay}
          durationInFrames={90 * FPS}
          fps={FPS}
          width={1920}
          height={1080}
        />
      </Folder>
      <Folder name="Showcase">
        <Folder name="Vertical">
          {SHOWCASE.map(([id, Comp, dur]) => (
            <Composition
              key={`${id}-vertical`}
              id={`${id}-vertical`}
              component={Comp}
              durationInFrames={dur * FPS}
              fps={FPS}
              width={1080}
              height={1920}
            />
          ))}
        </Folder>
        <Folder name="Landscape">
          {SHOWCASE.map(([id, Comp, dur]) => (
            <Composition
              key={`${id}-landscape`}
              id={`${id}-landscape`}
              component={Comp}
              durationInFrames={dur * FPS}
              fps={FPS}
              width={1920}
              height={1080}
            />
          ))}
        </Folder>
      </Folder>
      <Folder name="Combined">
        <Folder name="Landscape">
          {COMBINED.map(([id, Comp, dur]) => (
            <Composition
              key={`${id}-landscape`}
              id={`${id}-landscape`}
              component={Comp}
              durationInFrames={dur * FPS}
              fps={FPS}
              width={1920}
              height={1080}
            />
          ))}
        </Folder>
        <Folder name="Vertical">
          {COMBINED.map(([id, Comp, dur]) => (
            <Composition
              key={`${id}-vertical`}
              id={`${id}-vertical`}
              component={Comp}
              durationInFrames={dur * FPS}
              fps={FPS}
              width={1080}
              height={1920}
            />
          ))}
        </Folder>
      </Folder>
      <Folder name="Promo">
        <Folder name="Landscape">
          <Composition
            id="promo-skill-creation-landscape"
            component={SkillCreationPromo}
            durationInFrames={45 * FPS}
            fps={FPS}
            width={1920}
            height={1080}
          />
          <Composition
            id="promo-arena-gameplay-landscape"
            component={ArenaGameplayPromo}
            durationInFrames={45 * FPS}
            fps={FPS}
            width={1920}
            height={1080}
          />
          <Composition
            id="promo-clawville-combined-landscape"
            component={ClawVillePromo}
            durationInFrames={75 * FPS}
            fps={FPS}
            width={1920}
            height={1080}
          />
        </Folder>
        <Folder name="Vertical">
          <Composition
            id="promo-skill-creation-vertical"
            component={SkillCreationPromo}
            durationInFrames={45 * FPS}
            fps={FPS}
            width={1080}
            height={1920}
          />
          <Composition
            id="promo-arena-gameplay-vertical"
            component={ArenaGameplayPromo}
            durationInFrames={45 * FPS}
            fps={FPS}
            width={1080}
            height={1920}
          />
          <Composition
            id="promo-clawville-combined-vertical"
            component={ClawVillePromo}
            durationInFrames={75 * FPS}
            fps={FPS}
            width={1080}
            height={1920}
          />
        </Folder>
      </Folder>
    </>
  );
};
