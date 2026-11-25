// Steel Men – registers every procedural robot part (side-effect imports) and re-exports the kit entry points.
import './RobotLegs.js';
import './RobotLegsB6.js';
import './RobotLegsB3.js';
import './RobotTorsos.js';
import './RobotTorsosB6.js';
import './RobotTorsosB3.js';
import './RobotArms.js';
import './RobotArmsMelee.js';
import './RobotArmsRanged.js';
import './RobotArmsB3.js';
import './RobotLegsA16.js';
import './RobotTorsosA16.js';
import './RobotArmsA16.js';

export {
  ProcRobot, createProcRobot, ProcRobotPart, createProcRobotPart, robotPartIds, resolveRobotCombo, robotKit, ROBOT_KIT,
} from './RobotKit.js';
